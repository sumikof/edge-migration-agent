import path from 'node:path';
import { getConfig, listScenarios, readJson, resolveScenario, scenarioHash, Config } from './core.js';
import { runIE } from './ie.js';
import { runEdge } from './edge.js';
import { compare } from './compare.js';
import { RunFailure, RunResult } from './runner.js';
import { diagnose, formatDoctor } from './doctor.js';
import { analyzeTarget, writeAnalysis } from './analyzer.js';
import { getMigrationConfig, TargetNotConfigured } from './target.js';
import { buildMigrationReport } from './report.js';
import { listRuns, lockBaseline, readLock, verifyBaseline } from './baseline.js';
import { applyEdits, beginAttempt, fixStatus, restoreAttempt, testAttempt, verifyAttempt, fixesDir, FixRefused, EditSpec } from './fix.js';

// Exit codes: 0 = passed, 1 = functional failure / mismatch / refused, 2 = usage or configuration error, 3 = environment error.
const EXIT = { ok: 0, fail: 1, usage: 2, env: 3 } as const;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
const { positional, flags } = parseArgs(process.argv.slice(2));
const action = positional[0] || 'doctor';
const sub = positional[1] || '';
const list = (v: string | true | undefined) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);
const scenarioName = str(flags.scenario) || process.env.SCENARIO || 'sample';

function printRun(r: RunResult): void {
  const tag = r.status === 'passed' ? 'PASS' : r.status === 'environment-error' ? 'ENV-ERROR' : 'FAIL';
  console.log(`${tag} ${r.target} ${r.scenario} run=${r.runId} engine=${r.engine.verified ? 'verified' : 'NOT verified'}${r.baselineId ? ` baseline=${r.baselineId}` : ''}`);
  if (r.error) console.log(`  ${r.error.kind}: ${r.error.message}`);
  for (const p of r.engine.problems) console.log(`  engine: ${p}`);
  const env = r.diagnostics.environment as { checks?: Array<{ id: string; status: string; detail: string }> } | undefined;
  for (const c of env?.checks?.filter((x) => x.status === 'fail' || x.status === 'warn') ?? []) console.log(`  doctor [${c.status}] ${c.id}: ${c.detail}`);
}
async function runTarget(target: 'ie' | 'edge', config: Config): Promise<RunResult> {
  const scenario = resolveScenario(scenarioName);
  try { return target === 'ie' ? await runIE(config, scenario) : await runEdge(config, scenario); }
  catch (e) { if (e instanceof RunFailure) return e.result; throw e; }
}
const runExit = (r: RunResult) => (r.status === 'passed' ? EXIT.ok : r.status === 'environment-error' ? EXIT.env : EXIT.fail);

async function main(): Promise<number> {
  if (action === 'doctor') {
    let config: Config | undefined;
    try { config = getConfig(); } catch (e) { console.error(String((e as Error).message)); }
    const report = await diagnose(config, (sub as 'ie' | 'edge') || 'all');
    console.log(`Node: ${process.version}; OS: ${process.platform}`);
    console.log(flags.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    return report.ok ? EXIT.ok : EXIT.env;
  }
  if (action === 'validate') {
    getConfig();
    getMigrationConfig();
    for (const s of listScenarios()) resolveScenario(s);
    console.log(`OK config/targets.json, config/migration.json, ${listScenarios().length} scenario(s)`);
    return EXIT.ok;
  }
  if (action === 'analyze') {
    let report;
    try { report = analyzeTarget(getMigrationConfig(), { scope: list(flags.scope), rules: list(flags.rules), masking: getConfig().masking }); }
    catch (e) { if (e instanceof TargetNotConfigured) { console.error(`SKIP analyze: ${e.message}`); return EXIT.usage; } throw e; }
    const out = writeAnalysis(report);
    const s = report.summary;
    console.log(`Analyzed ${s.files} file(s) in ${report.targetRoot}: ${s.findings} finding(s)`);
    console.log(`  priority ${Object.entries(s.byPriority).map(([k, v]) => `${k}=${v}`).join(' ')} | ${Object.entries(s.byClassification).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    console.log(`  ${out.json}\n  ${out.markdown}`);
    return EXIT.ok;
  }
  if (action === 'report') {
    const { report, dir } = buildMigrationReport({ scenarios: list(flags.scenarios) });
    console.log(`${report.verdict.toUpperCase()} migration report: ${path.join(dir, 'index.html')}`);
    for (const r of report.reasons) console.log(`  - ${r}`);
    return report.verdict === 'complete' ? EXIT.ok : report.verdict === 'blocked' ? EXIT.env : EXIT.fail;
  }
  if (action === 'baseline') {
    const scenario = resolveScenario(scenarioName);
    if (sub === 'lock') {
      const lock = lockBaseline(scenario.name, scenarioHash(scenario), { runId: str(flags.run), replace: !!flags.replace, note: str(flags.note) });
      console.log(`LOCKED baseline ${lock.runId} for ${scenario.name} (${Object.keys(lock.files).length} files hashed, made read-only)`);
      return EXIT.ok;
    }
    if (sub === 'verify') {
      const lock = readLock(scenario.name);
      if (!lock) { console.log(`No locked baseline for ${scenario.name}`); return EXIT.fail; }
      const problems = verifyBaseline(lock);
      console.log(problems.length ? `TAMPERED ${lock.runId}: ${problems.join(', ')}` : `INTACT ${lock.runId}`);
      return problems.length ? EXIT.env : EXIT.ok;
    }
    const lock = readLock(scenario.name);
    for (const t of ['ie', 'edge'] as const) {
      for (const { result: r } of listRuns(t, scenario.name)) {
        console.log(`${t.padEnd(4)} ${r.runId} ${r.status.padEnd(17)} engine=${r.engine.verified ? 'ok' : 'no'} ${r.environment.mock ? 'mock' : r.environment.realWindows ? 'windows' : r.environment.platform}${r.runId === lock?.runId ? ' [LOCKED BASELINE]' : ''}${r.scenarioHash !== scenarioHash(scenario) ? ' [stale scenario]' : ''}`);
      }
    }
    return EXIT.ok;
  }
  if (action === 'fix') return fixCommand();

  const config = getConfig();
  if (action === 'run') {
    if (sub !== 'ie' && sub !== 'edge') { console.error('Use run ie or run edge'); return EXIT.usage; }
    const r = await runTarget(sub, config);
    printRun(r);
    return runExit(r);
  }
  if (action === 'compare') {
    const result = await compare(config, scenarioName, { ieRunId: str(flags.ie), edgeRunId: str(flags.edge), scenario: resolveScenario(scenarioName) });
    const c = result.report.counts;
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.report.status} functional=${c.functional} display=${c.display} environment=${c.environment} warnings=${c.warning}`);
    console.log(`  ${result.reportPath}\n  ${path.join(result.dir, 'report.html')}\n  ${path.join(result.dir, 'junit.xml')}`);
    return result.passed ? EXIT.ok : result.report.status === 'environment-error' ? EXIT.env : EXIT.fail;
  }
  if (action === 'dual') {
    // Serial on purpose: IE mode first, then Edge, then compare.
    const ie = await runTarget('ie', config);
    printRun(ie);
    const edge = await runTarget('edge', config);
    printRun(edge);
    try {
      const result = await compare(config, scenarioName, { scenario: resolveScenario(scenarioName) });
      console.log(`${result.passed ? 'PASS' : 'FAIL'} comparison ${result.report.status}: ${result.reportPath}`);
      if (result.report.baseline.runId !== ie.runId) console.log(`  note: compared against baseline ${result.report.baseline.runId} (locked or latest passed), not the IE run just recorded.`);
      return result.passed ? EXIT.ok : result.report.status === 'environment-error' ? EXIT.env : EXIT.fail;
    } catch (e) {
      console.error(`comparison: ${(e as Error).message}`);
      return ie.status === 'environment-error' || edge.status === 'environment-error' ? EXIT.env : EXIT.fail;
    }
  }
  console.error(`Unknown command: ${action}`);
  return EXIT.usage;
}

async function fixCommand(): Promise<number> {
  try {
    if (sub === 'begin') {
      const a = beginAttempt({ findings: list(flags.findings), files: list(flags.files), scenario: str(flags.scenario) ?? process.env.SCENARIO, reason: str(flags.reason) ?? '', useCompareEvidence: !!flags['use-compare'] });
      console.log(`OPEN attempt ${a.id} for ${a.files.map((f) => `${f.rel} (${f.encoding}${f.bom ? '+BOM' : ''}, ${f.eol})`).join(', ')}`);
      console.log('  next: write an edits JSON ([{"file","findingId","oldText","newText"}]) and run "npm run fix:apply -- --edits <file>"');
      return EXIT.ok;
    }
    if (sub === 'apply') {
      const file = str(flags.edits);
      if (!file) { console.error('--edits <file.json> is required'); return EXIT.usage; }
      const data = readJson<EditSpec[] | { edits: EditSpec[] }>(path.resolve(file));
      const a = applyEdits(Array.isArray(data) ? data : data.edits);
      console.log(`APPLIED ${a.edits.length} edit(s) in attempt ${a.id}; next: npm run fix:verify`);
      return EXIT.ok;
    }
    if (sub === 'verify') {
      const a = verifyAttempt();
      console.log(`${a.verify?.ok ? 'VERIFIED' : 'BLOCKED'} attempt ${a.id}${a.verify?.problems.length ? `: ${a.verify.problems.join('; ')}` : ''}`);
      console.log(`  diff: ${path.join(fixesDir(), a.id, 'post.diff')}`);
      return a.verify?.ok ? EXIT.ok : EXIT.fail;
    }
    if (sub === 'test') {
      const config = getConfig();
      const { attempt, next } = await testAttempt(config, (s) => runEdge(config, s));
      for (const t of attempt.tests.slice(-Math.max(1, new Set(attempt.tests.map((x) => x.scenario)).size))) console.log(`  ${t.scenario}: ${t.status} (compare ${t.compareId})`);
      console.log(next);
      return attempt.status === 'passed' ? EXIT.ok : attempt.status === 'blocked' ? EXIT.env : EXIT.fail;
    }
    if (sub === 'restore') {
      const a = restoreAttempt(str(flags.attempt));
      console.log(`REVERTED attempt ${a.id}: ${a.files.map((f) => f.rel).join(', ')} restored byte-for-byte`);
      return EXIT.ok;
    }
    console.log(JSON.stringify(fixStatus(), null, 2));
    return EXIT.ok;
  } catch (e) {
    if (e instanceof FixRefused || e instanceof TargetNotConfigured) { console.error(`REFUSED: ${e.message}`); return EXIT.fail; }
    throw e;
  }
}

main().then((code) => { process.exitCode = code; }).catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = EXIT.usage;
});
