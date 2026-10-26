import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Target, artifactsRoot, readJson, safeName, saveJson } from './core.js';
import type { RunResult } from './runner.js';

// Baselines are IE runs promoted to immutable evidence. A lock records the run id,
// the scenario hash it was produced with and a sha256 of every file in the run
// directory, so later tampering or accidental overwrites are detectable.

export type BaselineLock = {
  scenario: string; runId: string; scenarioHash: string; lockedAt: string; files: Record<string, string>; note?: string;
};

export function runsDir(target: Target, scenario: string): string {
  return path.join(artifactsRoot(), target, safeName(scenario));
}
export function lockFile(scenario: string): string {
  return path.join(artifactsRoot(), 'baselines', `${safeName(scenario)}.json`);
}
export function listRuns(target: Target, scenario: string): Array<{ dir: string; result: RunResult }> {
  const base = runsDir(target, scenario);
  if (!fs.existsSync(base)) return [];
  const out: Array<{ dir: string; result: RunResult }> = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const file = path.join(base, entry.name, 'result.json');
    if (!entry.isDirectory() || !fs.existsSync(file)) continue;
    try {
      const result = readJson<RunResult>(file);
      if (result.schemaVersion >= 2 && result.runId === entry.name) out.push({ dir: path.join(base, entry.name), result });
    } catch { /* unreadable runs are ignored, never deleted */ }
  }
  return out.sort((a, b) => a.result.startedAt.localeCompare(b.result.startedAt));
}
export function hasLegacyResult(target: Target, scenario: string): boolean {
  return fs.existsSync(path.join(runsDir(target, scenario), 'result.json'));
}
export function loadRun(target: Target, scenario: string, runId: string): { dir: string; result: RunResult } {
  const dir = path.join(runsDir(target, scenario), safeName(runId));
  const file = path.join(dir, 'result.json');
  if (!fs.existsSync(file)) throw new Error(`Run ${runId} not found for ${target}/${scenario}`);
  return { dir, result: readJson<RunResult>(file) };
}
export function latestRun(target: Target, scenario: string, filter: (r: RunResult) => boolean = () => true) {
  return listRuns(target, scenario).filter((r) => filter(r.result)).pop();
}
export function readLock(scenario: string): BaselineLock | undefined {
  const file = lockFile(scenario);
  return fs.existsSync(file) ? readJson<BaselineLock>(file) : undefined;
}
/** The IE run that Edge runs and comparisons should use: the locked baseline, else the latest passed IE run. */
export function resolveBaselineId(scenario: string): string | null {
  return readLock(scenario)?.runId ?? latestRun('ie', scenario, (r) => r.status === 'passed')?.result.runId ?? null;
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.posix.join(rel.split(path.sep).join('/'), e.name);
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out.sort();
}
function hashFiles(dir: string): Record<string, string> {
  return Object.fromEntries(walk(dir).map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]));
}
function makeReadOnly(dir: string): void {
  for (const f of walk(dir)) { try { fs.chmodSync(path.join(dir, f), 0o444); } catch { /* best effort */ } }
}

export function lockBaseline(scenario: string, currentScenarioHash: string, opts: { runId?: string; replace?: boolean; note?: string } = {}): BaselineLock {
  const existing = readLock(scenario);
  if (existing && !opts.replace) {
    throw new Error(`Scenario ${scenario} already has a locked baseline (${existing.runId}). Pass --replace to lock a newer run; the old lock is kept in history.`);
  }
  const run = opts.runId ? loadRun('ie', scenario, opts.runId) : latestRun('ie', scenario, (r) => r.status === 'passed');
  if (!run) throw new Error(`No passed IE run for ${scenario}. Run "npm run baseline:ie" first.`);
  const r = run.result;
  if (r.target !== 'ie' || r.status !== 'passed' || !r.engine.verified) {
    throw new Error(`Run ${r.runId} cannot be a baseline: status=${r.status}, engine verified=${r.engine.verified}.`);
  }
  if (r.scenarioHash !== currentScenarioHash) {
    throw new Error(`Run ${r.runId} was produced with a different version of scenario ${scenario}. Re-run the IE baseline.`);
  }
  const lock: BaselineLock = { scenario, runId: r.runId, scenarioHash: r.scenarioHash, lockedAt: new Date().toISOString(), files: hashFiles(run.dir), note: opts.note };
  fs.mkdirSync(path.dirname(lockFile(scenario)), { recursive: true });
  if (existing) {
    const hist = path.join(path.dirname(lockFile(scenario)), `${scenario}.history.jsonl`);
    fs.appendFileSync(hist, JSON.stringify({ ...existing, replacedAt: lock.lockedAt }) + '\n', 'utf8');
  }
  if (fs.existsSync(lockFile(scenario))) fs.chmodSync(lockFile(scenario), 0o644);
  saveJson(lockFile(scenario), lock);
  makeReadOnly(run.dir);
  return lock;
}

/** Returns a list of integrity problems for the locked baseline (empty when intact). */
export function verifyBaseline(lock: BaselineLock): string[] {
  const dir = path.join(runsDir('ie', lock.scenario), lock.runId);
  if (!fs.existsSync(dir)) return [`Baseline run directory ${dir} is missing`];
  const now = hashFiles(dir);
  const problems: string[] = [];
  for (const [f, h] of Object.entries(lock.files)) {
    if (!now[f]) problems.push(`missing ${f}`);
    else if (now[f] !== h) problems.push(`modified ${f}`);
  }
  for (const f of Object.keys(now)) if (!lock.files[f]) problems.push(`unexpected new file ${f}`);
  return problems;
}
