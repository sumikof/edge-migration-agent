import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CaptureCategory, Config, Scenario, Step, Target, SCHEMA_VERSION, assertNotProduction, newRunDir, newRunId,
  outputDir, resolveEnvValue, saveJson, scenarioHash, sha256, urlFor,
} from './core.js';
import { Masker } from './mask.js';
import { DOM_SNAPSHOT, ENGINE_INFO, EngineInfo, FORM_STATE } from './page-scripts.js';

// ---------------------------------------------------------------------------
// Error taxonomy. Comparison and reports rely on these kinds to separate
// functional mismatches from environment problems.
// ---------------------------------------------------------------------------
export type ErrorKind = 'assertion' | 'timeout' | 'unexpected-dialog' | 'script' | 'environment' | 'engine-mismatch' | 'safety';
export class HarnessError extends Error {
  constructor(public readonly kind: ErrorKind, message: string) { super(message); this.name = `HarnessError(${kind})`; }
}
/** Thrown by runIE/runEdge when a run did not pass; carries the stored result. */
export class RunFailure extends Error {
  constructor(public readonly result: RunResult) {
    super(`${result.target} run ${result.runId} ${result.status}: ${result.error?.message ?? 'unknown error'}`);
    this.name = 'RunFailure';
  }
}
export const envError = (message: string) => new HarnessError('environment', message);
export function errorKind(e: unknown): ErrorKind {
  if (e instanceof HarnessError) return e.kind;
  const name = (e as Error)?.name ?? '';
  if (/Timeout/i.test(name)) return 'timeout';
  return 'script';
}

export type Locator = { selector?: string; xpath?: string; frames: string[] };
export type WindowInfo = { id: string; url: string; title: string; current: boolean };
export type DialogRecord = { type: string; message: string; action?: string };
export type Diagnostics = {
  console: string[]; pageErrors: string[]; network: string[]; blockedRequests: string[]; scriptErrors: string[]; notes: string[];
};

/** Browser-specific primitives. All waits are bounded by timeoutMs. */
export interface BrowserAdapter {
  navigate(url: string, timeoutMs: number): Promise<void>;
  waitFor(loc: Locator, state: 'visible' | 'hidden', timeoutMs: number): Promise<void>;
  click(loc: Locator, timeoutMs: number): Promise<void>;
  fill(loc: Locator, value: string, timeoutMs: number): Promise<void>;
  select(loc: Locator, choice: { value?: string; label?: string; index?: number }, timeoutMs: number): Promise<void>;
  setChecked(loc: Locator, checked: boolean, timeoutMs: number): Promise<void>;
  press(loc: Locator | null, key: string, timeoutMs: number): Promise<void>;
  text(loc: Locator, timeoutMs: number): Promise<string>;
  value(loc: Locator, timeoutMs: number): Promise<string>;
  attribute(loc: Locator, name: string, timeoutMs: number): Promise<string | null>;
  isChecked(loc: Locator, timeoutMs: number): Promise<boolean>;
  isVisible(loc: Locator): Promise<boolean>;
  /** Runs an ES3 `function(el, arg)` source against the located element and returns its string result. */
  evalElement(loc: Locator, fnSource: string, arg: unknown, timeoutMs: number): Promise<string>;
  /** Runs an ES3 `function(el, arg)` source in the top document of the current window (el is null). */
  evalPage(fnSource: string, arg: unknown): Promise<string>;
  url(): Promise<string>;
  screenshot(file: string, mask: Locator[]): Promise<{ masked: boolean }>;
  windows(): Promise<WindowInfo[]>;
  switchWindow(id: string): Promise<void>;
  closeWindow(): Promise<void>;
  /** Called before the step that is expected to open a dialog (Playwright must answer it synchronously). */
  armDialog(spec: { action: 'accept' | 'dismiss'; promptText?: string }): void;
  handleDialog(spec: { action: 'accept' | 'dismiss'; promptText?: string }, timeoutMs: number): Promise<DialogRecord>;
  takeUnexpectedDialogs(): Promise<DialogRecord[]>;
  afterStep(): Promise<void>;
  drainDiagnostics(): Promise<Partial<Diagnostics>>;
  browserVersion(): Promise<string>;
  close(): Promise<void>;
}

export type StepResult = {
  index: number; op: string; status: 'passed' | 'failed' | 'skipped';
  error?: string; errorKind?: ErrorKind; attempts: number; durationMs: number; note?: string;
};
export type CaptureMeta = { category: CaptureCategory; kind: 'text' | 'value' | 'attribute' | 'url' | 'dialog' | 'formState'; step: number };
export type EngineCheck = { verified: boolean; expected: string; problems: string[]; pages: EngineInfo[] };
export type RunEnvironment = {
  platform: string; release: string; node: string; interactive: boolean | null; mock: boolean;
  realWindows: boolean; browserVersion?: string; driver?: string; notes: string[];
};
export type RunResult = {
  schemaVersion: number;
  runId: string;
  target: Target;
  scenario: string;
  scenarioHash: string;
  baselineId: string | null;
  startedAt: string;
  finishedAt: string;
  status: 'passed' | 'failed' | 'environment-error';
  /** Kept for compatibility with the starter's result.json. */
  passed: boolean;
  error?: { kind: ErrorKind; message: string; step?: number };
  environment: RunEnvironment;
  engine: EngineCheck;
  captures: Record<string, string>;
  captureMeta: Record<string, CaptureMeta>;
  dom: Record<string, { file: string; sha256: string; lines: number; category: CaptureCategory }>;
  dialogs: Array<DialogRecord & { step: number }>;
  urls: Array<{ step: number; url: string }>;
  screenshots: Array<{ name: string; file: string; step: number; masked: boolean }>;
  diagnostics: Diagnostics & { environment?: unknown };
  results: StepResult[];
};

export type RunOptions = {
  target: Target;
  config: Config;
  scenario: Scenario;
  baseUrl: string;
  baselineId: string | null;
  launch: () => Promise<{ adapter: BrowserAdapter; driver?: string }>;
  /** Called when launching fails; its output is stored as environment diagnostics. */
  diagnose?: () => Promise<unknown>;
  mock?: boolean;
  interactive?: boolean | null;
  environmentNotes?: string[];
};

const IDEMPOTENT = new Set(['waitVisible', 'waitHidden', 'waitText', 'waitUrl', 'assertTextContains', 'assertTextEquals',
  'assertValue', 'assertChecked', 'assertUrlContains', 'assertVisible', 'assertNotVisible', 'captureText', 'captureValue',
  'captureAttribute', 'captureDom', 'captureFormState', 'captureUrl', 'screenshot', 'navigate', 'fill', 'select', 'check', 'uncheck']);

function locatorOf(step: Step): Locator {
  const frames = step.frame === undefined ? [] : Array.isArray(step.frame) ? step.frame : [step.frame];
  return { selector: step.selector, xpath: step.xpath, frames };
}
function describe(loc: Locator): string {
  return [...loc.frames.map((f) => `frame(${f})`), loc.xpath ? `xpath(${loc.xpath})` : loc.selector ?? ''].join(' > ');
}
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HarnessError('timeout', `${what} did not finish within ${ms} ms`)), ms);
  });
  try { return await Promise.race([promise, guard]); } finally { clearTimeout(timer); }
}
async function poll<T>(probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, interval = 200): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last = await probe();
  while (!ok(last)) {
    if (Date.now() >= end) return last;
    await new Promise((r) => setTimeout(r, interval));
    last = await probe();
  }
  return last;
}
const squash = (s: string) => s.replace(/[\s 　]+/g, ' ').trim();

export function relativeUrl(base: string, url: string): string {
  try {
    const u = new URL(url), b = new URL(base);
    return u.origin === b.origin ? u.pathname + u.search + u.hash : url;
  } catch { return url; }
}

export function verifyEngine(target: Target, config: Config, pages: EngineInfo[]): EngineCheck {
  const problems: string[] = [];
  let expected: string;
  if (!pages.length) problems.push('No page was loaded, so the rendering engine could not be verified.');
  if (target === 'ie') {
    const mode = config.ie.expectedDocumentMode;
    expected = `IE engine (Trident) via Edge IE mode${mode ? `, documentMode ${mode}` : ''}`;
    for (const p of pages) {
      if (typeof p.documentMode !== 'number') problems.push(`${p.url}: document.documentMode is undefined - page is not rendered by the IE engine (check the Enterprise Mode site list).`);
      else if (mode && p.documentMode !== mode) problems.push(`${p.url}: documentMode ${p.documentMode}, expected ${mode}.`);
      if (!/Trident|MSIE/.test(p.userAgent)) problems.push(`${p.url}: user agent is not Trident (${p.userAgent}).`);
    }
  } else {
    expected = config.edge.requireEdgeBrand ? 'Chromium Microsoft Edge (Blink)' : 'Chromium (Blink)';
    for (const p of pages) {
      if (p.documentMode !== null) problems.push(`${p.url}: document.documentMode=${p.documentMode} - page is running in IE mode, not Chromium.`);
      if (/Trident|MSIE/.test(p.userAgent)) problems.push(`${p.url}: Trident user agent in Edge run.`);
      if (config.edge.requireEdgeBrand && !/Edg\//.test(p.userAgent) && !p.brands.includes('Microsoft Edge')) {
        problems.push(`${p.url}: browser is not Microsoft Edge (${p.userAgent}).`);
      }
    }
  }
  return { verified: problems.length === 0, expected, problems, pages };
}

/** Executes a scenario with any adapter and writes an immutable, redacted run directory. */
export async function runScenario(opts: RunOptions): Promise<{ result: RunResult; dir: string }> {
  const { target, config, scenario } = opts;
  assertNotProduction(config);
  const masker = new Masker(config.masking);
  const secrets = new Set<string>();
  // Resolve ${env:...} before launching so a missing variable fails fast and every secret is known to the masker.
  const steps: Step[] = scenario.steps.map((s) => ({ ...s, value: resolveEnvValue(s.value, secrets), promptText: resolveEnvValue(s.promptText, secrets) }));
  for (const s of steps) if (s.secret && s.value) secrets.add(s.value);
  masker.addSecrets(secrets);

  const runId = newRunId(target);
  const dir = newRunDir(target, scenario.name, runId);
  const result: RunResult = {
    schemaVersion: SCHEMA_VERSION, runId, target, scenario: scenario.name, scenarioHash: scenarioHash(scenario),
    baselineId: opts.baselineId, startedAt: new Date().toISOString(), finishedAt: '', status: 'passed', passed: true,
    environment: {
      platform: process.platform, release: os.release(), node: process.version, interactive: opts.interactive ?? null,
      mock: !!opts.mock, realWindows: process.platform === 'win32' && !opts.mock, notes: [...(opts.environmentNotes ?? [])],
    },
    engine: { verified: false, expected: '', problems: [], pages: [] },
    captures: {}, captureMeta: {}, dom: {}, dialogs: [], urls: [], screenshots: [],
    diagnostics: { console: [], pageErrors: [], network: [], blockedRequests: [], scriptErrors: [], notes: [] },
    results: [],
  };
  const pages: EngineInfo[] = [];
  let adapter: BrowserAdapter | undefined;

  const fail = (kind: ErrorKind, message: string, step?: number) => {
    if (!result.error) result.error = { kind, message, step };
  };
  try {
    let launchError: unknown;
    for (let attempt = 0; attempt <= config.retries.launch && !adapter; attempt++) {
      try {
        const launched = await withTimeout(opts.launch(), Math.max(config.timeoutMs * 4, 60000), `${target} browser launch`);
        adapter = launched.adapter;
        result.environment.driver = launched.driver;
      } catch (e) { launchError = e; }
    }
    if (!adapter) {
      fail('environment', `Browser launch failed: ${(launchError as Error)?.message ?? launchError}`);
      if (opts.diagnose) {
        try { result.diagnostics.environment = await opts.diagnose(); } catch (e) { result.diagnostics.notes.push(`diagnose failed: ${e}`); }
      }
    } else {
      try { result.environment.browserVersion = await adapter.browserVersion(); } catch {}
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        const next = steps[index + 1];
        if (next?.op === 'dialog') adapter.armDialog({ action: next.action ?? 'accept', promptText: next.promptText });
        const timeoutMs = step.timeoutMs ?? config.timeoutMs;
        const maxAttempts = 1 + (step.retries ?? (IDEMPOTENT.has(step.op) ? config.retries.step : 0));
        const started = Date.now();
        let attempts = 0;
        let lastError: unknown;
        while (attempts < maxAttempts) {
          attempts++;
          try {
            await withTimeout(runStep(adapter, step, index, timeoutMs), timeoutMs * 3 + 5000, `step ${index} (${step.op})`);
            // When the next step answers a dialog, an open dialog right now is expected.
            const unexpected = next?.op === 'dialog' ? [] : await adapter.takeUnexpectedDialogs();
            if (unexpected.length) {
              for (const d of unexpected) result.dialogs.push({ ...d, step: index, action: 'dismissed-unexpected' });
              throw new HarnessError('unexpected-dialog', `Unexpected ${unexpected[0].type} dialog: ${unexpected[0].message}`);
            }
            lastError = undefined;
            break;
          } catch (e) {
            lastError = e;
            if (errorKind(e) === 'environment' || errorKind(e) === 'unexpected-dialog') break;
          }
        }
        if (next?.op !== 'dialog') { try { await adapter.afterStep(); } catch {} }
        const base = { index, op: step.op, attempts, durationMs: Date.now() - started, note: step.note };
        if (!lastError) { result.results.push({ ...base, status: 'passed' }); continue; }
        const kind = errorKind(lastError);
        const message = String((lastError as Error)?.message ?? lastError);
        if (step.optional && kind !== 'environment') {
          result.results.push({ ...base, status: 'skipped', error: message, errorKind: kind });
          continue;
        }
        result.results.push({ ...base, status: 'failed', error: message, errorKind: kind });
        fail(kind, `Step ${index} (${step.op}) failed: ${message}`, index);
        try { await adapter.screenshot(path.join(dir, 'failure.png'), []); } catch {}
        break;
      }
    }
  } catch (e) {
    fail(errorKind(e) === 'script' ? 'environment' : errorKind(e), `Harness error: ${(e as Error)?.message ?? e}`);
  } finally {
    if (adapter) {
      try {
        const d = await adapter.drainDiagnostics();
        for (const key of Object.keys(result.diagnostics) as Array<keyof Diagnostics>) {
          const extra = d[key];
          if (Array.isArray(extra)) (result.diagnostics[key] as string[]).push(...extra.slice(0, 200));
        }
      } catch {}
      try { await adapter.close(); } catch {}
    }
    result.engine = verifyEngine(target, config, pages);
    if (adapter && !result.engine.verified && (!result.error || result.error.kind !== 'environment')) {
      // A run that did not execute on the expected engine is not evidence of anything.
      result.error = { kind: 'engine-mismatch', message: result.engine.problems.join(' ') };
    }
    const k = result.error?.kind;
    result.status = !result.error ? 'passed' : (k === 'environment' || k === 'engine-mismatch' || k === 'safety') ? 'environment-error' : 'failed';
    result.passed = result.status === 'passed';
    result.finishedAt = new Date().toISOString();
    const redacted = masker.redactDeep(result);
    saveJson(path.join(dir, 'result.json'), redacted);
    saveJson(path.join(outputDir(target, scenario.name), 'latest.json'), { runId, status: redacted.status, finishedAt: redacted.finishedAt });
  }
  return { result: masker.redactDeep(result), dir };

  async function recordPage(index: number): Promise<void> {
    const raw = await adapter!.evalPage(ENGINE_INFO, null);
    const info = JSON.parse(raw) as EngineInfo;
    pages.push(info);
    result.urls.push({ step: index, url: relativeUrl(opts.baseUrl, info.url) });
  }
  function capture(key: string, value: string, meta: CaptureMeta): void {
    result.captures[key] = value;
    result.captureMeta[key] = meta;
  }

  async function runStep(a: BrowserAdapter, step: Step, index: number, t: number): Promise<void> {
    const loc = locatorOf(step);
    const category: CaptureCategory = step.category ?? 'business';
    const key = step.key ?? `step-${index}`;
    switch (step.op) {
      case 'navigate':
        await a.navigate(urlFor(opts.baseUrl, step.path!), t);
        await recordPage(index);
        return;
      case 'screenshot': {
        const name = step.name ?? `step-${index}`;
        if (!/^[\w-]+$/.test(name)) throw new HarnessError('script', `Invalid screenshot name: ${name}`);
        const masks = (step.mask ?? []).map((m) => ({ selector: m, frames: loc.frames }));
        const { masked } = await a.screenshot(path.join(dir, `${name}.png`), masks);
        if (masks.length && !masked) result.diagnostics.notes.push(`screenshot ${name}: element masking is not supported by ${target}; do not share it.`);
        result.screenshots.push({ name, file: `${name}.png`, step: index, masked });
        return;
      }
      case 'wait':
        await new Promise((r) => setTimeout(r, Math.min(step.ms ?? 0, 10000)));
        return;
      case 'waitVisible': await a.waitFor(loc, 'visible', t); return;
      case 'waitHidden': await a.waitFor(loc, 'hidden', t); return;
      case 'waitText': {
        const want = step.text ?? '';
        const got = await poll(() => a.text(loc, t).catch(() => ''), (v) => v.includes(want), t);
        if (!got.includes(want)) throw new HarnessError('timeout', `Text ${JSON.stringify(want)} did not appear in ${describe(loc)} within ${t} ms`);
        return;
      }
      case 'waitUrl': case 'assertUrlContains': {
        const want = step.urlContains ?? step.text ?? '';
        const got = await poll(() => a.url(), (v) => v.includes(want), step.op === 'waitUrl' ? t : 0);
        if (!got.includes(want)) throw new HarnessError(step.op === 'waitUrl' ? 'timeout' : 'assertion', `URL ${JSON.stringify(relativeUrl(opts.baseUrl, got))} does not contain ${JSON.stringify(want)}`);
        if (step.op === 'waitUrl') await recordPage(index);
        return;
      }
      case 'click': await a.click(loc, t); return;
      case 'fill': await a.fill(loc, step.value ?? '', t); return;
      case 'select': await a.select(loc, { value: step.value, label: step.label, index: step.index }, t); return;
      case 'check': await a.setChecked(loc, true, t); return;
      case 'uncheck': await a.setChecked(loc, false, t); return;
      case 'press': await a.press(loc.selector || loc.xpath ? loc : null, step.value ?? step.key!, t); return;
      case 'assertTextContains': {
        const actual = await a.text(loc, t);
        if (!actual.includes(step.text ?? '')) throw new HarnessError('assertion', `Text mismatch at step ${index}: expected ${JSON.stringify(step.text)}, actual ${JSON.stringify(actual.slice(0, 300))}`);
        return;
      }
      case 'assertTextEquals': {
        const actual = await a.text(loc, t);
        if (squash(actual) !== squash(step.text ?? '')) throw new HarnessError('assertion', `Text mismatch at step ${index}: expected ${JSON.stringify(step.text)}, actual ${JSON.stringify(actual.slice(0, 300))}`);
        return;
      }
      case 'assertValue': {
        const actual = await a.value(loc, t);
        if (actual !== (step.value ?? '')) throw new HarnessError('assertion', `Value mismatch at step ${index}: expected ${JSON.stringify(step.value)}, actual ${JSON.stringify(actual.slice(0, 300))}`);
        return;
      }
      case 'assertChecked': {
        const want = step.value === undefined ? true : step.value === 'true';
        const actual = await a.isChecked(loc, t);
        if (actual !== want) throw new HarnessError('assertion', `Checked state mismatch at step ${index}: expected ${want}, actual ${actual}`);
        return;
      }
      case 'assertVisible':
        try { await a.waitFor(loc, 'visible', t); } catch (e) { throw new HarnessError('assertion', `${describe(loc)} is not visible: ${(e as Error).message}`); }
        return;
      case 'assertNotVisible':
        if (await a.isVisible(loc)) throw new HarnessError('assertion', `${describe(loc)} is visible`);
        return;
      case 'captureText': capture(key, await a.text(loc, t), { category, kind: 'text', step: index }); return;
      case 'captureValue': capture(key, step.secret ? '<SECRET>' : await a.value(loc, t), { category, kind: 'value', step: index }); return;
      case 'captureAttribute': capture(key, (await a.attribute(loc, step.attribute!, t)) ?? '<null>', { category, kind: 'attribute', step: index }); return;
      case 'captureUrl': capture(key, relativeUrl(opts.baseUrl, await a.url()), { category, kind: 'url', step: index }); return;
      case 'captureFormState': {
        const raw = await a.evalElement(loc, FORM_STATE, null, t);
        capture(key, JSON.stringify(JSON.parse(raw), null, 1), { category, kind: 'formState', step: index });
        return;
      }
      case 'captureDom': {
        if (!/^[\w-]+$/.test(key)) throw new HarnessError('script', `Invalid capture key: ${key}`);
        const text = masker.redact(await a.evalElement(loc, DOM_SNAPSHOT, config.compare.domIgnoreAttributes, t));
        fs.mkdirSync(path.join(dir, 'dom'), { recursive: true });
        const file = `dom/${key}.txt`;
        fs.writeFileSync(path.join(dir, file), text + '\n', 'utf8');
        result.dom[key] = { file, sha256: sha256(text), lines: text.split('\n').length, category: step.category ?? 'display' };
        return;
      }
      case 'switchWindow': {
        const match = (w: WindowInfo) => step.index !== undefined ? false
          : (step.urlContains === undefined || w.url.includes(step.urlContains)) && (step.titleContains === undefined || w.title.includes(step.titleContains));
        const wins = await poll(() => a.windows(), (ws) => step.index !== undefined ? ws.length > step.index : ws.some(match), t);
        const chosen = step.index !== undefined ? wins[step.index] : wins.find(match);
        if (!chosen) throw new HarnessError('timeout', `No window matched ${JSON.stringify({ urlContains: step.urlContains, titleContains: step.titleContains, index: step.index })}; open: ${wins.map((w) => relativeUrl(opts.baseUrl, w.url)).join(', ')}`);
        await a.switchWindow(chosen.id);
        await recordPage(index);
        return;
      }
      case 'closeWindow':
        await a.closeWindow();
        await recordPage(index);
        return;
      case 'dialog': {
        const d = await a.handleDialog({ action: step.action ?? 'accept', promptText: step.promptText }, t);
        result.dialogs.push({ ...d, step: index, action: step.action ?? 'accept' });
        if (step.text !== undefined && !d.message.includes(step.text)) {
          throw new HarnessError('assertion', `Dialog message ${JSON.stringify(d.message)} does not contain ${JSON.stringify(step.text)}`);
        }
        if (step.key) capture(step.key, d.message, { category, kind: 'dialog', step: index });
        return;
      }
    }
    throw new HarnessError('script', `Unknown step: ${(step as Step).op}`);
  }
}
