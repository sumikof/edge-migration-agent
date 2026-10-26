import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertValid } from './schema.js';
import { configSchema, scenarioSchema, STEP_OPS } from './schemas.js';

export type Target = 'ie' | 'edge';
export type StepOp = typeof STEP_OPS[number];
export type CaptureCategory = 'business' | 'validation' | 'display';
export type Step = {
  op: StepOp;
  path?: string;
  selector?: string;
  xpath?: string;
  /** One iframe (CSS or "xpath=...") or a chain of nested iframes, outermost first. */
  frame?: string | string[];
  value?: string;
  label?: string;
  index?: number;
  text?: string;
  key?: string;
  name?: string;
  attribute?: string;
  optional?: boolean;
  secret?: boolean;
  category?: CaptureCategory;
  timeoutMs?: number;
  retries?: number;
  ms?: number;
  action?: 'accept' | 'dismiss';
  promptText?: string;
  titleContains?: string;
  urlContains?: string;
  mask?: string[];
  note?: string;
};
export type Scenario = { name: string; description?: string; tags?: string[]; allowMutatingRequests?: boolean; steps: Step[] };
export type PatternRule = { name: string; regex: string; flags?: string; replacement?: string };
export type Config = {
  ieBaseUrl: string; edgeBaseUrl: string; edgeExecutablePath: string;
  viewport: { width: number; height: number }; timeoutMs: number;
  visualDiffThreshold: number; maxDiffRatio: number;
  retries: { step: number; launch: number };
  ie: { expectedDocumentMode: number | null; ensureCleanSession: boolean; ignoreZoomSetting: boolean; attachTimeoutMs: number };
  edge: { channel: string; headless: boolean; requireEdgeBrand: boolean };
  compare: { visualGate: boolean; failOnPageErrors: boolean; failOnHttpErrors: boolean; ignoreCaptureKeys: string[]; domIgnoreAttributes: string[] };
  masking: { redactPII: boolean; redact: PatternRule[]; normalizeDynamic: boolean; normalize: PatternRule[] };
  safety: { blockMutatingRequests: boolean; productionUrlPatterns: string[] };
};

export const root = process.cwd();
export const SCHEMA_VERSION = 2;

export function artifactsRoot(): string {
  return process.env.ARTIFACTS_DIR ? path.resolve(process.env.ARTIFACTS_DIR) : path.join(root, 'artifacts');
}
export function safeName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error(`Unsafe name: ${value}. Use letters, digits, _ or - only.`);
  }
  return value;
}
export function readJson<T = unknown>(file: string): T {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try { return JSON.parse(text) as T; }
  catch (e) { throw new Error(`Malformed JSON in ${file}: ${(e as Error).message}`); }
}
export function parseScenario(data: unknown, file = 'scenario'): Scenario {
  const scenario = assertValid<Scenario>(scenarioSchema, data, file);
  for (const [i, s] of scenario.steps.entries()) {
    const need = (cond: boolean, what: string) => { if (!cond) throw new Error(`Invalid ${file}: step ${i} (${s.op}) requires ${what}`); };
    const locator = !!(s.selector || s.xpath);
    switch (s.op) {
      case 'navigate': need(!!s.path, '"path"'); break;
      case 'screenshot': case 'wait': case 'dialog': case 'closeWindow': case 'captureUrl': case 'switchWindow': break;
      case 'waitUrl': case 'assertUrlContains': need(!!(s.urlContains ?? s.text), '"urlContains" or "text"'); break;
      case 'press': need(!!s.key || !!s.value, '"value" (key name)'); break;
      case 'captureAttribute': need(locator && !!s.attribute, 'a locator and "attribute"'); break;
      case 'select': need(locator && (s.value !== undefined || s.label !== undefined || s.index !== undefined), 'a locator and "value", "label" or "index"'); break;
      default: need(locator, '"selector" or "xpath"');
    }
    if (s.selector && s.xpath) throw new Error(`Invalid ${file}: step ${i} has both selector and xpath`);
  }
  return scenario;
}
export function scenariosDir(): string {
  return process.env.SCENARIOS_DIR ? path.resolve(process.env.SCENARIOS_DIR) : path.join(root, 'scenarios');
}
export function resolveScenario(name: string): Scenario {
  const file = path.join(scenariosDir(), safeName(name) + '.json');
  const data = parseScenario(readJson(file), file);
  if (data.name !== name) throw new Error(`Invalid scenario ${file}: name "${data.name}" does not match file name`);
  return data;
}
export function listScenarios(): string[] {
  const dir = scenariosDir();
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : [];
}

export const DEFAULTS = {
  edgeExecutablePath: '',
  retries: { step: 0, launch: 1 },
  ie: { expectedDocumentMode: null, ensureCleanSession: true, ignoreZoomSetting: false, attachTimeoutMs: 30000 },
  edge: { channel: 'msedge', headless: false, requireEdgeBrand: true },
  compare: { visualGate: false, failOnPageErrors: true, failOnHttpErrors: false, ignoreCaptureKeys: [], domIgnoreAttributes: [] },
  masking: { redactPII: true, redact: [], normalizeDynamic: true, normalize: [] },
  safety: { blockMutatingRequests: true, productionUrlPatterns: [] },
} satisfies Partial<Config>;

export function parseConfig(data: unknown, file = 'config/targets.json'): Config {
  const raw = assertValid<Partial<Config>>(configSchema, data, file);
  const config = {
    ...raw,
    edgeExecutablePath: raw.edgeExecutablePath ?? DEFAULTS.edgeExecutablePath,
    retries: { ...DEFAULTS.retries, ...raw.retries },
    ie: { ...DEFAULTS.ie, ...raw.ie },
    edge: { ...DEFAULTS.edge, ...raw.edge },
    compare: { ...DEFAULTS.compare, ...raw.compare },
    masking: { ...DEFAULTS.masking, ...raw.masking },
    safety: { ...DEFAULTS.safety, ...raw.safety },
  } as Config;
  for (const rule of [...config.masking.redact, ...config.masking.normalize]) {
    try { new RegExp(rule.regex, rule.flags); } catch (e) { throw new Error(`Invalid ${file}: masking rule ${rule.name}: ${(e as Error).message}`); }
  }
  for (const p of config.safety.productionUrlPatterns) {
    try { new RegExp(p, 'i'); } catch (e) { throw new Error(`Invalid ${file}: safety.productionUrlPatterns: ${(e as Error).message}`); }
  }
  return config;
}
export function getConfig(file = process.env.TARGETS_CONFIG || path.join(root, 'config/targets.json')): Config {
  return parseConfig(readJson(file), file);
}
export function outputDir(target: Target, name: string): string {
  const dir = path.join(artifactsRoot(), target, safeName(name));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function newRunId(prefix: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}
/** Creates a brand new run directory. Existing run directories are never reused. */
export function newRunDir(target: Target, name: string, runId: string): string {
  const dir = path.join(outputDir(target, name), safeName(runId));
  fs.mkdirSync(dir, { recursive: false });
  return dir;
}
export function urlFor(base: string, pagePath: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(pagePath) || pagePath.startsWith('//')) {
    throw new Error('Navigation must be a relative path, not an external URL');
  }
  const origin = new URL(base);
  const resolved = new URL(pagePath, origin);
  if (resolved.origin !== origin.origin) throw new Error('Navigation escaped the configured origin');
  return resolved.href;
}
export function saveJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
export function hasFile(file: string): boolean { return fs.existsSync(file); }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}
export function sha256(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(canonical(value));
  return crypto.createHash('sha256').update(text).digest('hex');
}
/** Hash of everything that defines what a run did, so stale comparisons can be detected. */
export function scenarioHash(scenario: Scenario): string {
  return sha256(scenario).slice(0, 16);
}

/** Resolves `${env:NAME}` in step values so credentials never live in scenario files. */
export function resolveEnvValue(value: string | undefined, secrets: Set<string>): string | undefined {
  if (value === undefined) return value;
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`Environment variable ${name} referenced by the scenario is not set`);
    if (v.length >= 3) secrets.add(v);
    return v;
  });
}

/** Refuses to automate URLs that match configured production patterns. */
export function assertNotProduction(config: Config): void {
  for (const url of [config.ieBaseUrl, config.edgeBaseUrl]) {
    for (const p of config.safety.productionUrlPatterns) {
      if (new RegExp(p, 'i').test(url)) throw new Error(`Refusing to run against ${url}: matches safety.productionUrlPatterns (${p}). Use a test environment.`);
    }
  }
}
