import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { Config, Scenario, artifactsRoot, newRunId, readJson, resolveScenario, safeName, saveJson, sha256 } from './core.js';
import { loadLatestAnalysis, Finding } from './analyzer.js';
import { compare, loadLatestCompare, CompareReport } from './compare.js';
import { latestRun, readLock, loadRun } from './baseline.js';
import { applyEol, decodeSource, encodeSource, Eol } from './source-text.js';
import { MigrationConfig, getMigrationConfig, matchesAny, resolveTargetRoot, targetPath, toRel } from './target.js';
import type { RunResult } from './runner.js';

// Fix attempts are the only sanctioned way to change the external business source.
// The CLI never decides WHAT to change - Claude Code does. The CLI enforces:
//   evidence (analysis finding / failing comparison), scope (allowWrite + writableGlobs),
//   a passed IE baseline first, clean files, exact single-occurrence edits that keep
//   encoding + line endings, before/after diffs, a test run per attempt, and budgets.

export type AttemptStatus = 'open' | 'applied' | 'verified' | 'passed' | 'failed' | 'blocked' | 'reverted';
export type AttemptFile = { rel: string; sha256Before: string; sha256Current: string; encoding: string; bom: boolean; eol: Eol; linked: boolean };
export type TestRecord = { scenario: string; edgeRunId: string | null; compareId: string | null; status: string; passed: boolean; signature: string; functional: string[] };
export type Attempt = {
  id: string;
  status: AttemptStatus;
  createdAt: string;
  targetRoot: string;
  scenario: string;
  reason: string;
  findings: Array<Pick<Finding, 'id' | 'ruleId' | 'file' | 'line' | 'priority' | 'classification'>>;
  evidence: { analysisId?: string; compare?: { compareId: string; status: string; functional: string[] }; baselineRunId: string };
  files: AttemptFile[];
  edits: Array<{ file: string; findingId?: string; line: number; removedChars: number; addedChars: number }>;
  verify?: { ok: boolean; problems: string[]; at: string };
  tests: TestRecord[];
  stop?: { reason: string; at: string };
  history: Array<{ at: string; event: string; detail?: string }>;
};
type Index = { attempts: Array<{ id: string; status: AttemptStatus; findings: string[]; scenario: string; createdAt: string; signature?: string }> };

export class FixRefused extends Error { constructor(msg: string) { super(msg); this.name = 'FixRefused'; } }

export function fixesDir(): string { return path.join(artifactsRoot(), 'fixes'); }
const indexFile = () => path.join(fixesDir(), 'index.json');
function readIndex(): Index { return fs.existsSync(indexFile()) ? readJson<Index>(indexFile()) : { attempts: [] }; }
function attemptDir(id: string): string { return path.join(fixesDir(), safeName(id)); }
export function loadAttempt(id: string): Attempt { return readJson<Attempt>(path.join(attemptDir(id), 'attempt.json')); }
function saveAttempt(a: Attempt): void {
  fs.mkdirSync(attemptDir(a.id), { recursive: true });
  saveJson(path.join(attemptDir(a.id), 'attempt.json'), a);
  const idx = readIndex();
  const entry = { id: a.id, status: a.status, findings: a.findings.map((f) => f.id), scenario: a.scenario, createdAt: a.createdAt, signature: a.tests.filter((t) => !t.passed).map((t) => t.signature).join('+') || undefined };
  const i = idx.attempts.findIndex((x) => x.id === a.id);
  if (i >= 0) idx.attempts[i] = entry; else idx.attempts.push(entry);
  fs.mkdirSync(fixesDir(), { recursive: true });
  saveJson(indexFile(), idx);
}
function log(a: Attempt, event: string, detail?: string) { a.history.push({ at: new Date().toISOString(), event, detail }); }
const hashBytes = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}
function isGitRepo(dir: string): boolean {
  try { return git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; }
}
function gitStatus(dir: string, files?: string[]): string[] {
  const out = git(dir, ['status', '--porcelain=v1', '-uall', ...(files?.length ? ['--', ...files] : [])]);
  return out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
}
export function openAttempt(): Attempt | undefined {
  const open = readIndex().attempts.filter((a) => ['open', 'applied', 'verified'].includes(a.status)).pop();
  return open ? loadAttempt(open.id) : undefined;
}

export type BeginInput = { findings: string[]; files: string[]; scenario?: string; reason: string; useCompareEvidence?: boolean };

export function beginAttempt(input: BeginInput, mc: MigrationConfig = getMigrationConfig()): Attempt {
  const targetRoot = resolveTargetRoot(mc);
  if (!mc.fix.allowWrite) throw new FixRefused('fix.allowWrite is false in config/migration.json. Writing to the business source must be explicitly enabled (and limited with fix.writableGlobs).');
  if (!mc.fix.writableGlobs.length) throw new FixRefused('fix.writableGlobs is empty. List the target-relative paths that may be modified (e.g. ["web/js/**/*.js"]).');
  if (!input.reason?.trim()) throw new FixRefused('A --reason describing the compatibility problem and the intended minimal change is required.');
  if (!input.files.length) throw new FixRefused('Declare the files to modify with --files.');
  const current = openAttempt();
  if (current) throw new FixRefused(`Attempt ${current.id} is still ${current.status}. Run "fix test" or "fix restore" before starting another attempt.`);

  // ---- Budgets / stop conditions ----
  const idx = readIndex();
  const counted = idx.attempts.filter((a) => a.status !== 'blocked');
  if (counted.length >= mc.fix.maxTotalAttempts) throw new FixRefused(`Stop condition: maxTotalAttempts (${mc.fix.maxTotalAttempts}) reached. Report the remaining issues to a human instead of trying again.`);
  for (const id of input.findings) {
    const n = counted.filter((a) => a.findings.includes(id)).length;
    if (n >= mc.fix.maxAttemptsPerFinding) throw new FixRefused(`Stop condition: finding ${id} already had ${n} attempts (maxAttemptsPerFinding=${mc.fix.maxAttemptsPerFinding}). Escalate to a human.`);
  }

  // ---- First-pass gate: functional evidence must exist before code changes (CLAUDE.md) ----
  const scenario = input.scenario ?? mc.fix.verifyScenarios[0] ?? process.env.SCENARIO;
  if (!scenario) throw new FixRefused('Name the verification scenario with --scenario (or set fix.verifyScenarios).');
  resolveScenario(scenario);
  const baselineRunId = readLock(scenario)?.runId ?? latestRun('ie', scenario, (r) => r.status === 'passed' && r.engine.verified)?.result.runId;
  if (!baselineRunId) throw new FixRefused(`No passed IE-mode baseline for scenario "${scenario}". Validate driver boot and navigation and record a baseline (npm run baseline:ie, npm run baseline:lock) before modifying code.`);
  const baseline = loadRun('ie', scenario, baselineRunId).result;
  if (!baseline.engine.verified) throw new FixRefused(`Baseline ${baselineRunId} did not verify the IE engine.`);

  // ---- Evidence ----
  const findings: Attempt['findings'] = [];
  let analysisId: string | undefined;
  if (input.findings.length) {
    const analysis = loadLatestAnalysis();
    if (!analysis) throw new FixRefused('No analysis found. Run "npm run analyze" first.');
    if (path.resolve(analysis.targetRoot) !== path.resolve(targetRoot)) throw new FixRefused(`Latest analysis was made for ${analysis.targetRoot}, not the configured target ${targetRoot}. Re-run "npm run analyze".`);
    analysisId = analysis.analysisId;
    for (const id of input.findings) {
      const f = analysis.findings.find((x) => x.id === id);
      if (!f) throw new FixRefused(`Finding ${id} is not in analysis ${analysis.analysisId}.`);
      if (f.classification === 'text-only') throw new FixRefused(`Finding ${id} is a text-only match (comment/string); it is not a compatibility defect.`);
      findings.push({ id: f.id, ruleId: f.ruleId, file: f.file, line: f.line, priority: f.priority, classification: f.classification });
    }
  }
  let compareEvidence: Attempt['evidence']['compare'];
  if (input.useCompareEvidence || !findings.length) {
    const c = loadLatestCompare(scenario);
    if (!c || c.status !== 'functional-mismatch') {
      throw new FixRefused(`No evidence: provide analysis finding ids (--findings) or a failing comparison for "${scenario}" (latest is ${c?.status ?? 'missing'}). Fixes without evidence are not allowed.`);
    }
    compareEvidence = { compareId: c.compareId, status: c.status, functional: c.differences.filter((d) => d.category === 'functional').map((d) => `${d.kind}:${d.key}`) };
  }

  // ---- Files: scope, cleanliness, encoding ----
  const rels = input.files.map((f) => toRel(targetRoot, targetPath(targetRoot, f)));
  for (const rel of rels) {
    if (!matchesAny(rel, mc.fix.writableGlobs)) throw new FixRefused(`${rel} is not covered by fix.writableGlobs (${mc.fix.writableGlobs.join(', ')}).`);
    if (!fs.existsSync(path.join(targetRoot, rel))) throw new FixRefused(`${rel} does not exist in the target.`);
  }
  const linkedFiles = new Set(findings.flatMap((f) => [f.file]));
  if (findings.length && !rels.some((r) => linkedFiles.has(r))) throw new FixRefused('None of the declared files contains the cited findings.');
  const repo = isGitRepo(targetRoot);
  if (mc.fix.requireGit && !repo) throw new FixRefused(`${targetRoot} is not a git work tree (fix.requireGit=true). Before/after diffs and safe review require git.`);
  if (repo && mc.fix.requireCleanFiles) {
    const dirty = gitStatus(targetRoot, rels);
    if (dirty.length) throw new FixRefused(`Declared files have uncommitted changes: ${dirty.join(', ')}. Commit or stash them yourself first; the agent never discards existing changes.`);
  }
  const id = newRunId('fix');
  const dir = attemptDir(id);
  fs.mkdirSync(path.join(dir, 'backup'), { recursive: true });
  const files: AttemptFile[] = [];
  for (const rel of rels) {
    const full = path.join(targetRoot, rel);
    const bytes = fs.readFileSync(full);
    const d = decodeSource(bytes, rel, mc.targetApp);
    if (!d.lossless || d.encoding === 'binary-latin1') throw new FixRefused(`${rel}: encoding ${d.encoding} cannot be round-tripped losslessly; refusing to edit it automatically.`);
    const backup = path.join(dir, 'backup', rel);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, bytes);
    const h = hashBytes(bytes);
    files.push({ rel, sha256Before: h, sha256Current: h, encoding: d.encoding, bom: d.bom, eol: d.eol, linked: linkedFiles.has(rel) || !!compareEvidence });
  }
  if (repo) {
    fs.writeFileSync(path.join(dir, 'pre-status.txt'), git(targetRoot, ['status', '--porcelain=v1', '-uall']), 'utf8');
    fs.writeFileSync(path.join(dir, 'pre.diff'), execFileSync('git', ['diff', '--', ...rels], { cwd: targetRoot, windowsHide: true }));
  }
  const attempt: Attempt = {
    id, status: 'open', createdAt: new Date().toISOString(), targetRoot, scenario, reason: input.reason.trim(), findings,
    evidence: { analysisId, compare: compareEvidence, baselineRunId }, files, edits: [], tests: [], history: [],
  };
  log(attempt, 'begin', `files=${rels.join(',')} findings=${input.findings.join(',') || '-'}`);
  saveAttempt(attempt);
  return attempt;
}

export type EditSpec = { file: string; findingId?: string; oldText: string; newText: string };

function countOccurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/** Applies exact, single-occurrence replacements while keeping encoding, BOM and line endings. */
export function applyEdits(edits: EditSpec[], mc: MigrationConfig = getMigrationConfig()): Attempt {
  const a = openAttempt();
  if (!a || !['open', 'applied'].includes(a.status)) throw new FixRefused('No open attempt. Run "fix begin" first.');
  if (path.resolve(resolveTargetRoot(mc)) !== path.resolve(a.targetRoot)) throw new FixRefused('Configured target changed since the attempt began.');
  if (!Array.isArray(edits) || !edits.length) throw new FixRefused('No edits given.');
  if (a.edits.length + edits.length > mc.fix.maxEditsPerAttempt) throw new FixRefused(`Too many edits for one attempt (max ${mc.fix.maxEditsPerAttempt}). Keep each attempt minimal.`);
  const byFile = new Map<string, EditSpec[]>();
  for (const e of edits) {
    if (typeof e.oldText !== 'string' || typeof e.newText !== 'string' || !e.oldText) throw new FixRefused('Each edit needs non-empty oldText and a newText string.');
    if (e.oldText === e.newText) throw new FixRefused(`Edit for ${e.file} does not change anything.`);
    if (e.oldText.length > 4000 || e.newText.length > 8000) throw new FixRefused('Edit too large; split it into minimal targeted edits.');
    const rel = toRel(a.targetRoot, targetPath(a.targetRoot, e.file));
    const file = a.files.find((f) => f.rel === rel);
    if (!file) throw new FixRefused(`${rel} was not declared in attempt ${a.id}.`);
    if (e.findingId && !a.findings.some((f) => f.id === e.findingId)) throw new FixRefused(`Finding ${e.findingId} is not part of attempt ${a.id}.`);
    byFile.set(rel, [...(byFile.get(rel) ?? []), e]);
  }
  // Validate everything before writing anything (all-or-nothing).
  const writes: Array<{ file: AttemptFile; bytes: Buffer; records: Attempt['edits'] }> = [];
  for (const [rel, list] of byFile) {
    const file = a.files.find((f) => f.rel === rel)!;
    const full = path.join(a.targetRoot, rel);
    const bytes = fs.readFileSync(full);
    if (hashBytes(bytes) !== file.sha256Current) throw new FixRefused(`${rel} changed outside the fix tool since the last step; refusing to overwrite it.`);
    const d = decodeSource(bytes, rel, mc.targetApp);
    if (d.encoding !== file.encoding || d.bom !== file.bom) throw new FixRefused(`${rel}: encoding detection changed (${file.encoding} -> ${d.encoding}).`);
    let text = d.text;
    const records: Attempt['edits'] = [];
    for (const e of list) {
      const variants = [...new Set([e.oldText, applyEol(e.oldText, file.eol === 'mixed' || file.eol === 'none' ? 'lf' : file.eol), applyEol(e.oldText, 'crlf'), applyEol(e.oldText, 'lf')])];
      let chosen: string | undefined, hits: number[] = [];
      for (const v of variants) { hits = countOccurrences(text, v); if (hits.length) { chosen = v; break; } }
      if (!chosen) throw new FixRefused(`oldText not found in ${rel}. Copy it exactly from the current file.`);
      if (hits.length > 1) throw new FixRefused(`oldText occurs ${hits.length} times in ${rel}; include more context so it is unique (bulk replacement is not allowed).`);
      const eol: Eol = chosen.includes('\r\n') ? 'crlf' : file.eol === 'mixed' || file.eol === 'none' ? (text.includes('\r\n') ? 'crlf' : 'lf') : file.eol;
      const replacement = applyEol(e.newText, eol);
      const line = text.slice(0, hits[0]).split(/\r\n|\n|\r/).length;
      text = text.slice(0, hits[0]) + replacement + text.slice(hits[0] + chosen.length);
      records.push({ file: rel, findingId: e.findingId, line, removedChars: chosen.length, addedChars: replacement.length });
    }
    let out: Buffer;
    try { out = encodeSource(text, d); } catch (err) { throw new FixRefused(`${rel}: ${(err as Error).message}`); }
    writes.push({ file, bytes: out, records });
  }
  for (const w of writes) {
    fs.writeFileSync(path.join(a.targetRoot, w.file.rel), w.bytes);
    w.file.sha256Current = hashBytes(w.bytes);
    a.edits.push(...w.records);
  }
  const editsLog = path.join(attemptDir(a.id), 'edits.json');
  const previous = fs.existsSync(editsLog) ? readJson<EditSpec[]>(editsLog) : [];
  saveJson(editsLog, [...previous, ...edits]);
  a.status = 'applied';
  log(a, 'apply', `${edits.length} edit(s) in ${[...byFile.keys()].join(', ')}`);
  saveAttempt(a);
  return a;
}

/** Checks scope, encoding and EOL preservation, then stores the after-diff. */
export function verifyAttempt(mc: MigrationConfig = getMigrationConfig()): Attempt {
  const a = openAttempt();
  if (!a) throw new FixRefused('No open attempt.');
  const problems: string[] = [];
  const dir = attemptDir(a.id);
  const repo = isGitRepo(a.targetRoot);
  if (repo) {
    const before = new Set(fs.readFileSync(path.join(dir, 'pre-status.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.slice(3)));
    const declared = new Set(a.files.map((f) => f.rel));
    for (const changed of gitStatus(a.targetRoot)) {
      if (!declared.has(changed) && !before.has(changed)) problems.push(`Undeclared change outside the attempt scope: ${changed}`);
    }
  }
  for (const f of a.files) {
    const full = path.join(a.targetRoot, f.rel);
    if (!fs.existsSync(full)) { problems.push(`${f.rel} was deleted`); continue; }
    const bytes = fs.readFileSync(full);
    const h = hashBytes(bytes);
    if (h !== f.sha256Current) {
      // Edited directly (e.g. Claude Code Edit tool on a UTF-8 file) - accept but re-validate.
      log(a, 'external-edit', f.rel);
      f.sha256Current = h;
    }
    const d = decodeSource(bytes, f.rel, mc.targetApp);
    if (d.encoding !== f.encoding) problems.push(`${f.rel}: encoding changed ${f.encoding} -> ${d.encoding}`);
    if (!d.lossless) problems.push(`${f.rel}: no longer decodes losslessly as ${f.encoding}`);
    if (d.bom !== f.bom) problems.push(`${f.rel}: BOM ${f.bom ? 'removed' : 'added'}`);
    if (f.eol !== 'mixed' && f.eol !== 'none' && d.eol !== f.eol) problems.push(`${f.rel}: line endings changed ${f.eol} -> ${d.eol}`);
  }
  const diffs: Buffer[] = [];
  for (const f of a.files) {
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--', path.join(dir, 'backup', f.rel), path.join(a.targetRoot, f.rel)], { windowsHide: true });
    diffs.push(r.stdout ?? Buffer.alloc(0));
  }
  fs.writeFileSync(path.join(dir, 'post.diff'), Buffer.concat(diffs));
  if (repo) fs.writeFileSync(path.join(dir, 'post.git.diff'), execFileSync('git', ['diff', '--', ...a.files.map((f) => f.rel)], { cwd: a.targetRoot, windowsHide: true }));
  if (a.files.every((f) => f.sha256Current === f.sha256Before)) problems.push('No file was changed.');
  a.verify = { ok: problems.length === 0, problems, at: new Date().toISOString() };
  if (problems.length) {
    a.status = 'blocked';
    a.stop = { reason: `verify failed: ${problems.join('; ')}`, at: a.verify.at };
  } else a.status = 'verified';
  log(a, 'verify', problems.join('; ') || 'ok');
  saveAttempt(a);
  return a;
}

export type TestRunner = (scenario: Scenario) => Promise<RunResult | void>;

function signatureOf(c: CompareReport): string {
  return sha256(c.differences.filter((d) => d.category !== 'warning' && d.category !== 'display').map((d) => `${d.category}:${d.kind}:${d.key}`).sort()).slice(0, 12);
}

/** Runs the Edge scenario(s) and comparison for the verified attempt and evaluates stop conditions. */
export async function testAttempt(config: Config, runEdgeFn: TestRunner, mc: MigrationConfig = getMigrationConfig()): Promise<{ attempt: Attempt; next: string }> {
  const a = openAttempt();
  if (!a || a.status !== 'verified') throw new FixRefused(`No verified attempt to test${a ? ` (attempt ${a.id} is ${a.status})` : ''}. Run "fix verify" first.`);
  const scenarios = [...new Set([a.scenario, ...mc.fix.verifyScenarios])];
  const before = new Map(scenarios.map((s) => [s, loadLatestCompare(s)?.passed]));
  for (const name of scenarios) {
    const scenario = resolveScenario(name);
    try { await runEdgeFn(scenario); } catch { /* the stored run result is what matters */ }
    try {
      const { report } = await compare(config, name, { scenario });
      a.tests.push({ scenario: name, edgeRunId: report.edgeRun.runId, compareId: report.compareId, status: report.status, passed: report.passed, signature: signatureOf(report), functional: report.differences.filter((d) => d.category === 'functional').map((d) => `${d.kind}:${d.key}: ${d.message}`).slice(0, 20) });
    } catch (e) {
      a.tests.push({ scenario: name, edgeRunId: null, compareId: null, status: 'environment-error', passed: false, signature: 'compare-error', functional: [String((e as Error).message)] });
    }
  }
  const latest = a.tests.slice(-scenarios.length);
  const env = latest.filter((t) => t.status === 'environment-error');
  const regressions = latest.filter((t) => !t.passed && before.get(t.scenario) === true && t.scenario !== a.scenario);
  let next: string;
  if (env.length) {
    a.status = 'blocked';
    a.stop = { reason: `environment error in ${env.map((t) => t.scenario).join(', ')} - not caused by code; fix the environment, then re-run "fix test" after "fix verify"`, at: new Date().toISOString() };
    next = `STOP (environment): ${a.stop.reason}. The change is kept; run "fix restore" if it should be undone.`;
  } else if (latest.every((t) => t.passed)) {
    a.status = 'passed';
    next = 'PASS: functional parity confirmed for all verification scenarios. Review post.diff, then commit in the target repository yourself (the agent never commits or deploys).';
  } else {
    a.status = 'failed';
    const idx = readIndex();
    const findingIds = a.findings.map((f) => f.id);
    const sig = latest.filter((t) => !t.passed).map((t) => t.signature).join('+');
    const sameBefore = idx.attempts.some((x) => x.id !== a.id && (x.status === 'failed' || x.status === 'reverted') && x.signature === sig && x.findings.some((f) => findingIds.includes(f)));
    const used = Math.max(0, ...findingIds.map((id) => idx.attempts.filter((x) => x.findings.includes(id) && x.status !== 'blocked').length));
    if (regressions.length) next = `REGRESSION in ${regressions.map((t) => t.scenario).join(', ')} (previously passing). Run "fix restore", analyze the diff, then retry.`;
    else if (sameBefore) next = 'STOP (no progress): the same failure signature occurred in a previous attempt for these findings. Run "fix restore" and escalate to a human with the evidence.';
    else if (findingIds.length && used >= mc.fix.maxAttemptsPerFinding) next = `STOP (budget): maxAttemptsPerFinding=${mc.fix.maxAttemptsPerFinding} reached. Run "fix restore" and escalate.`;
    else next = `FAIL: analyze the functional differences (compare report ${latest.map((t) => t.compareId).join(', ')}), run "fix restore" to undo or start a corrected attempt after restoring. Attempts used for these findings: ${used}/${mc.fix.maxAttemptsPerFinding}.`;
    if (next.startsWith('STOP')) a.stop = { reason: next, at: new Date().toISOString() };
  }
  log(a, 'test', `${latest.map((t) => `${t.scenario}=${t.status}`).join(', ')}`);
  saveAttempt(a);
  return { attempt: a, next };
}

/** Restores the backed-up bytes of the latest non-reverted attempt, only if nobody changed the files since. */
export function restoreAttempt(id?: string): Attempt {
  const idx = readIndex();
  const entry = id ? idx.attempts.find((x) => x.id === id) : [...idx.attempts].reverse().find((x) => x.status !== 'reverted' && x.status !== 'passed');
  if (!entry) throw new FixRefused('No attempt to restore.');
  const a = loadAttempt(entry.id);
  if (a.status === 'reverted') throw new FixRefused(`Attempt ${a.id} is already reverted.`);
  for (const f of a.files) {
    const full = path.join(a.targetRoot, f.rel);
    const current = fs.existsSync(full) ? hashBytes(fs.readFileSync(full)) : 'missing';
    if (current !== f.sha256Current && current !== f.sha256Before) throw new FixRefused(`${f.rel} was modified after the attempt; refusing to overwrite. Resolve it manually using ${path.join(attemptDir(a.id), 'post.diff')}.`);
  }
  for (const f of a.files) {
    fs.writeFileSync(path.join(a.targetRoot, f.rel), fs.readFileSync(path.join(attemptDir(a.id), 'backup', f.rel)));
    f.sha256Current = f.sha256Before;
  }
  a.status = 'reverted';
  log(a, 'restore');
  saveAttempt(a);
  return a;
}

export function fixStatus(mc: MigrationConfig = getMigrationConfig()) {
  const idx = readIndex();
  const counted = idx.attempts.filter((a) => a.status !== 'blocked');
  return {
    open: openAttempt()?.id ?? null,
    budget: { used: counted.length, maxTotalAttempts: mc.fix.maxTotalAttempts, maxAttemptsPerFinding: mc.fix.maxAttemptsPerFinding },
    attempts: idx.attempts,
  };
}
