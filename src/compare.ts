import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import { Config, artifactsRoot, newRunId, safeName, saveJson, scenarioHash, Scenario } from './core.js';
import { Masker } from './mask.js';
import { hasLegacyResult, latestRun, loadRun, readLock, verifyBaseline } from './baseline.js';
import type { CaptureCategory } from './core.js';
import type { RunResult } from './runner.js';
import { renderCompareHtml, renderJUnit } from './report.js';

// Functional evidence first: step outcomes, business captures, validation messages,
// form state, dialogs and navigation decide pass/fail. DOM structure and images are
// display evidence and only fail the comparison when compare.visualGate is enabled.

export type DiffCategory = 'functional' | 'display' | 'environment' | 'warning';
export type Difference = {
  category: DiffCategory;
  kind: string;
  key: string;
  message: string;
  ie?: string;
  edge?: string;
};
export type ImageResult = { file: string; status: 'within-tolerance' | 'different' | 'different-size' | 'missing-edge' | 'missing-ie'; diffRatio?: number; dimensions?: string; diffFile?: string };
export type CompareStatus = 'match' | 'display-difference' | 'functional-mismatch' | 'environment-error';
export type CompareReport = {
  schemaVersion: 2;
  compareId: string;
  createdAt: string;
  scenario: string;
  status: CompareStatus;
  passed: boolean;
  baseline: { runId: string | null; locked: boolean; scenarioHash?: string; realWindows?: boolean; mock?: boolean };
  edgeRun: { runId: string | null; baselineId?: string | null; scenarioHash?: string; mock?: boolean };
  counts: Record<DiffCategory, number>;
  differences: Difference[];
  images: ImageResult[];
  checks: { steps: number; captures: number; dom: number; dialogs: number; urls: number; images: number };
  // Fields kept from the starter's report.json.
  iePassed: boolean;
  edgePassed: boolean;
  textDiffs: string[];
  ieCaptures: Record<string, string>;
  edgeCaptures: Record<string, string>;
};

export type CompareOptions = { ieRunId?: string; edgeRunId?: string; scenario?: Scenario };

function compareDir(name: string): string { return path.join(artifactsRoot(), 'compare', safeName(name)); }
const functionalCategory = (c: CaptureCategory | undefined): DiffCategory => (c === 'display' ? 'display' : 'functional');

function lineDiff(a: string[], b: string[], limit = 15): string[] {
  // Small LCS-free diff: report positions where lines differ, aligned by index after trimming common prefix/suffix.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const out: string[] = [];
  for (let i = start; i <= Math.max(endA, endB) && out.length < limit; i++) {
    if (i <= endA) out.push(`- ${a[i]}`);
    if (i <= endB) out.push(`+ ${b[i]}`);
  }
  return out;
}

async function compareImages(config: Config, ieDir: string, edgeDir: string, ie: RunResult, edge: RunResult, out: string): Promise<ImageResult[]> {
  const images: ImageResult[] = [];
  const ieFiles = ie.screenshots.map((s) => s.file);
  const edgeFiles = edge.screenshots.map((s) => s.file);
  for (const file of ieFiles) {
    const lhs = path.join(ieDir, file), rhs = path.join(edgeDir, file);
    if (!edgeFiles.includes(file) || !fs.existsSync(rhs)) { images.push({ file, status: 'missing-edge' }); continue; }
    const a = sharp(lhs), b = sharp(rhs);
    const ma = await a.metadata(), mb = await b.metadata();
    if (ma.width !== mb.width || ma.height !== mb.height || !ma.width || !ma.height) {
      images.push({ file, status: 'different-size', dimensions: `${ma.width}x${ma.height} vs ${mb.width}x${mb.height}` });
      continue;
    }
    const width = ma.width, height = ma.height;
    const va = await a.ensureAlpha().raw().toBuffer();
    const vb = await b.ensureAlpha().raw().toBuffer();
    const diff = Buffer.alloc(width * height * 4);
    const count = pixelmatch(va, vb, diff, width, height, { threshold: config.visualDiffThreshold });
    const diffFile = `diff-${file}`;
    await sharp(diff, { raw: { width, height, channels: 4 } }).png().toFile(path.join(out, diffFile));
    const ratio = count / (width * height);
    images.push({ file, status: ratio <= config.maxDiffRatio ? 'within-tolerance' : 'different', diffRatio: ratio, diffFile });
  }
  for (const file of edgeFiles) if (!ieFiles.includes(file)) images.push({ file, status: 'missing-ie' });
  return images;
}

export async function compare(config: Config, name: string, opts: CompareOptions = {}): Promise<{ passed: boolean; reportPath: string; report: CompareReport; dir: string }> {
  safeName(name);
  const masker = new Masker(config.masking);
  const diffs: Difference[] = [];
  const add = (d: Difference) => diffs.push({ ...d, ie: d.ie === undefined ? undefined : masker.redact(d.ie), edge: d.edge === undefined ? undefined : masker.redact(d.edge) });

  const lock = readLock(name);
  const ieRunId = opts.ieRunId ?? lock?.runId ?? latestRun('ie', name, (r) => r.status === 'passed')?.result.runId;
  const edgeRunId = opts.edgeRunId ?? latestRun('edge', name)?.result.runId;
  if (!ieRunId || !edgeRunId) {
    const legacy = hasLegacyResult('ie', name) || hasLegacyResult('edge', name) ? ' Found starter-format result.json files; re-run them with this version (runs are now stored per run id).' : '';
    throw new Error(`Nothing to compare for ${name}: ${!ieRunId ? 'no passed IE baseline run (npm run baseline:ie)' : 'no Edge run (npm run test:edge)'}.${legacy}`);
  }
  const ie = loadRun('ie', name, ieRunId);
  const edge = loadRun('edge', name, edgeRunId);
  const I = ie.result, E = edge.result;

  // ---- Integrity: never compare against the wrong or a modified baseline ----
  if (lock && lock.runId === I.runId) {
    const problems = verifyBaseline(lock);
    if (problems.length) add({ category: 'environment', kind: 'baseline-tampered', key: 'baseline', message: `Locked baseline ${lock.runId} was modified: ${problems.join(', ')}` });
  }
  if (I.target !== 'ie' || E.target !== 'edge') add({ category: 'environment', kind: 'invalid-comparison', key: 'targets', message: `Expected an IE and an Edge run, got ${I.target}/${E.target}` });
  if (I.scenarioHash !== E.scenarioHash) {
    add({ category: 'environment', kind: 'stale-comparison', key: 'scenarioHash', message: 'IE and Edge runs were produced with different scenario definitions. Re-run the outdated side.', ie: I.scenarioHash, edge: E.scenarioHash });
  }
  if (opts.scenario && scenarioHash(opts.scenario) !== I.scenarioHash) {
    add({ category: 'environment', kind: 'stale-baseline', key: 'scenarioHash', message: `The scenario file changed after baseline ${I.runId} was recorded. Record and lock a new IE baseline.` });
  }
  if (E.baselineId !== I.runId) {
    add({ category: 'environment', kind: 'baseline-mismatch', key: 'baselineId', message: `Edge run ${E.runId} was recorded against baseline ${E.baselineId ?? '(none)'}, not ${I.runId}. Re-run "npm run test:edge" so the comparison uses the current baseline.`, ie: I.runId, edge: String(E.baselineId) });
  }
  // ---- Environment ----
  for (const r of [I, E]) {
    if (r.status === 'environment-error') add({ category: 'environment', kind: r.error?.kind ?? 'environment', key: `${r.target}.run`, message: `${r.target} run ${r.runId}: ${r.error?.message ?? 'environment error'}` });
    else if (!r.engine.verified) add({ category: 'environment', kind: 'engine-mismatch', key: `${r.target}.engine`, message: r.engine.problems.join(' ') });
  }
  if (I.status === 'failed') add({ category: 'environment', kind: 'baseline-invalid', key: 'ie.run', message: `IE baseline ${I.runId} itself failed (${I.error?.message}); fix the scenario before comparing.` });

  // ---- Functional: steps ----
  for (const ir of I.results) {
    const er = E.results.find((r) => r.index === ir.index);
    if (!er) {
      if (E.status !== 'environment-error') add({ category: 'functional', kind: 'step-not-reached', key: `step-${ir.index}`, message: `Step ${ir.index} (${ir.op}) was not reached in Edge`, ie: ir.status, edge: 'not-run' });
      continue;
    }
    if (ir.status !== 'failed' && er.status === 'failed') add({ category: 'functional', kind: 'step-failed', key: `step-${ir.index}`, message: `Step ${ir.index} (${ir.op}) failed in Edge: ${er.error}`, ie: ir.status, edge: er.status });
    else if (ir.status === 'passed' && er.status === 'skipped') add({ category: 'warning', kind: 'optional-step-skipped', key: `step-${ir.index}`, message: `Optional step ${ir.index} (${ir.op}) passed in IE but was skipped in Edge: ${er.error}` });
  }
  // ---- Functional: captures (business values, validation messages, form state, dialogs, urls) ----
  const ignore = new Set(config.compare.ignoreCaptureKeys);
  const keys = [...new Set([...Object.keys(I.captures), ...Object.keys(E.captures)])].filter((k) => !ignore.has(k)).sort();
  const textDiffs: string[] = [];
  for (const key of keys) {
    const meta = I.captureMeta?.[key] ?? E.captureMeta?.[key];
    const a = I.captures[key], b = E.captures[key];
    const category = functionalCategory(meta?.category);
    if (a === undefined || b === undefined) {
      if (E.status === 'environment-error') continue;
      textDiffs.push(key);
      add({ category, kind: 'capture-missing', key, message: `Capture "${key}" exists only in ${a === undefined ? 'Edge' : 'IE'}`, ie: a, edge: b });
      continue;
    }
    if (masker.normalize(a) !== masker.normalize(b)) {
      textDiffs.push(key);
      const kind = meta?.category === 'validation' ? 'validation-message' : meta?.kind === 'formState' ? 'form-state' : meta?.kind === 'dialog' ? 'dialog-message' : 'capture-value';
      add({ category, kind, key, message: `"${key}" differs (${meta?.category ?? 'business'})`, ie: a, edge: b });
    }
  }
  const dialogsI = I.dialogs.map((d) => masker.normalize(d.message)), dialogsE = E.dialogs.map((d) => masker.normalize(d.message));
  if (E.status !== 'environment-error' && JSON.stringify(dialogsI) !== JSON.stringify(dialogsE)) {
    add({ category: 'functional', kind: 'dialogs', key: 'dialogs', message: 'Dialog sequence differs', ie: JSON.stringify(dialogsI), edge: JSON.stringify(dialogsE) });
  }
  const urlsI = I.urls.map((u) => masker.normalize(u.url)), urlsE = E.urls.map((u) => masker.normalize(u.url));
  if (E.status !== 'environment-error' && JSON.stringify(urlsI) !== JSON.stringify(urlsE)) {
    add({ category: 'functional', kind: 'navigation', key: 'urls', message: 'Navigation sequence (relative URLs) differs', ie: urlsI.join(' -> '), edge: urlsE.join(' -> ') });
  }
  // ---- DOM snapshots ----
  const domKeys = [...new Set([...Object.keys(I.dom ?? {}), ...Object.keys(E.dom ?? {})])].sort();
  for (const key of domKeys) {
    const a = I.dom?.[key], b = E.dom?.[key];
    const category = functionalCategory(a?.category ?? b?.category);
    if (!a || !b) { if (E.status !== 'environment-error') add({ category, kind: 'dom-missing', key, message: `DOM snapshot "${key}" exists only in ${a ? 'IE' : 'Edge'}` }); continue; }
    const la = masker.normalize(fs.readFileSync(path.join(ie.dir, a.file), 'utf8')).split('\n');
    const lb = masker.normalize(fs.readFileSync(path.join(edge.dir, b.file), 'utf8')).split('\n');
    const d = lineDiff(la, lb);
    if (d.length) add({ category, kind: 'dom', key, message: `DOM snapshot "${key}" differs`, ie: d.filter((l) => l.startsWith('-')).join('\n'), edge: d.filter((l) => l.startsWith('+')).join('\n') });
  }
  // ---- Edge runtime diagnostics ----
  for (const e of E.diagnostics.pageErrors) add({ category: config.compare.failOnPageErrors ? 'functional' : 'warning', kind: 'page-error', key: 'pageErrors', message: `Uncaught exception in Edge: ${e}` });
  for (const n of E.diagnostics.network) add({ category: config.compare.failOnHttpErrors ? 'functional' : 'warning', kind: 'network', key: 'network', message: n });
  for (const c of E.diagnostics.console.slice(0, 20)) add({ category: 'warning', kind: 'console', key: 'console', message: c });
  for (const b of E.diagnostics.blockedRequests) add({ category: 'warning', kind: 'blocked-request', key: 'safety', message: `Mutating request blocked by safety.blockMutatingRequests: ${b}` });

  // ---- Images: auxiliary ----
  const out = path.join(compareDir(name), newRunId('cmp'));
  fs.mkdirSync(out, { recursive: true });
  const images = await compareImages(config, ie.dir, edge.dir, I, E, out);
  for (const img of images.filter((i) => i.status !== 'within-tolerance')) {
    add({ category: 'display', kind: `image-${img.status}`, key: img.file, message: `Screenshot ${img.file}: ${img.status}${img.diffRatio !== undefined ? ` (${(img.diffRatio * 100).toFixed(2)}% pixels)` : ''}${img.dimensions ? ` ${img.dimensions}` : ''}` });
  }

  const counts = { functional: 0, display: 0, environment: 0, warning: 0 } as Record<DiffCategory, number>;
  for (const d of diffs) counts[d.category]++;
  const status: CompareStatus = counts.environment ? 'environment-error' : counts.functional ? 'functional-mismatch' : counts.display ? 'display-difference' : 'match';
  const passed = status === 'match' || (status === 'display-difference' && !config.compare.visualGate);
  const report: CompareReport = {
    schemaVersion: 2, compareId: path.basename(out), createdAt: new Date().toISOString(), scenario: name, status, passed,
    baseline: { runId: I.runId, locked: lock?.runId === I.runId, scenarioHash: I.scenarioHash, realWindows: I.environment.realWindows, mock: I.environment.mock },
    edgeRun: { runId: E.runId, baselineId: E.baselineId, scenarioHash: E.scenarioHash, mock: E.environment.mock },
    counts, differences: diffs, images,
    checks: { steps: I.results.length, captures: keys.length, dom: domKeys.length, dialogs: dialogsI.length, urls: urlsI.length, images: images.length },
    iePassed: I.passed, edgePassed: E.passed, textDiffs, ieCaptures: I.captures, edgeCaptures: E.captures,
  };
  const reportPath = path.join(out, 'report.json');
  saveJson(reportPath, report);
  fs.writeFileSync(path.join(out, 'report.html'), renderCompareHtml(report), 'utf8');
  fs.writeFileSync(path.join(out, 'junit.xml'), renderJUnit([report]), 'utf8');
  saveJson(path.join(compareDir(name), 'latest.json'), { compareId: report.compareId, status, passed, createdAt: report.createdAt });
  return { passed, reportPath, report, dir: out };
}

export function loadLatestCompare(name: string): CompareReport | undefined {
  const pointer = path.join(compareDir(name), 'latest.json');
  if (!fs.existsSync(pointer)) return undefined;
  const { compareId } = JSON.parse(fs.readFileSync(pointer, 'utf8')) as { compareId: string };
  const file = path.join(compareDir(name), compareId, 'report.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as CompareReport : undefined;
}
