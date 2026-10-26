import fs from 'node:fs';
import path from 'node:path';
import { artifactsRoot, listScenarios, newRunId, readJson, root, saveJson } from './core.js';
import type { CompareReport, Difference } from './compare.js';
import type { AnalysisReport } from './analyzer.js';
import { latestRun, readLock } from './baseline.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const xml = (s: unknown) => esc(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const STYLE = `
:root{--bg:#fff;--fg:#1d2330;--muted:#5d6676;--line:#d9dee7;--ok:#1f7a3d;--warn:#946200;--bad:#b42318;--env:#6941c6;--card:#f6f8fb}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e6e9ef;--muted:#9aa3b2;--line:#2c323c;--ok:#4cc27a;--warn:#e0b252;--bad:#ff7a6e;--env:#b69cff;--card:#1a1f26}}
body{font:14px/1.5 system-ui,"Segoe UI","Yu Gothic UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:1200px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.muted{color:var(--muted)}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--card)}pre{white-space:pre-wrap;word-break:break-all;margin:0;font:12px/1.4 ui-monospace,Consolas,monospace}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px;border:1px solid currentColor}
.match,.passed,.complete,.functional-ok{color:var(--ok)}.display-difference,.display,.warning,.incomplete{color:var(--warn)}
.functional-mismatch,.functional,.failed{color:var(--bad)}.environment-error,.environment,.blocked{color:var(--env)}
.cards{display:flex;gap:12px;flex-wrap:wrap}.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px 14px;min-width:140px}
.card b{display:block;font-size:20px}`;

function diffRows(diffs: Difference[]): string {
  if (!diffs.length) return '<p class="muted">None.</p>';
  return `<table><tr><th>Category</th><th>Kind</th><th>Key</th><th>Message</th><th>IE</th><th>Edge</th></tr>${diffs.map((d) => `<tr><td><span class="badge ${esc(d.category)}">${esc(d.category)}</span></td><td>${esc(d.kind)}</td><td>${esc(d.key)}</td><td>${esc(d.message)}</td><td><pre>${esc(d.ie ?? '')}</pre></td><td><pre>${esc(d.edge ?? '')}</pre></td></tr>`).join('')}</table>`;
}

export function renderCompareHtml(r: CompareReport): string {
  const order: Difference['category'][] = ['environment', 'functional', 'display', 'warning'];
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Compare ${esc(r.scenario)}</title><style>${STYLE}</style></head><body>
<h1>IE mode vs Edge: ${esc(r.scenario)} <span class="badge ${esc(r.status)}">${esc(r.status)}</span></h1>
<p class="muted">${esc(r.compareId)} · ${esc(r.createdAt)} · baseline ${esc(r.baseline.runId)} (${r.baseline.locked ? 'locked' : 'NOT locked'}${r.baseline.mock ? ', mock' : r.baseline.realWindows ? ', real Windows' : ''}) · edge ${esc(r.edgeRun.runId)}${r.edgeRun.mock ? ' (mock)' : ''}</p>
<div class="cards">${order.map((c) => `<div class="card"><span class="${c}">${c}</span><b>${r.counts[c]}</b></div>`).join('')}<div class="card">checked<b>${r.checks.steps} steps · ${r.checks.captures} values · ${r.checks.dom} DOM · ${r.checks.images} images</b></div></div>
<p>Functional evidence decides the result; image differences are auxiliary${r.passed ? '' : ''}.</p>
${order.map((c) => `<h2 class="${c}">${c}</h2>${diffRows(r.differences.filter((d) => d.category === c))}`).join('')}
<h2>Screenshots</h2><table><tr><th>File</th><th>Status</th><th>Diff ratio</th><th>Diff image</th></tr>${r.images.map((i) => `<tr><td>${esc(i.file)}</td><td>${esc(i.status)}</td><td>${i.diffRatio === undefined ? '' : (i.diffRatio * 100).toFixed(2) + '%'}</td><td>${i.diffFile ? `<a href="${esc(i.diffFile)}">${esc(i.diffFile)}</a>` : esc(i.dimensions ?? '')}</td></tr>`).join('')}</table>
</body></html>
`;
}

/** JUnit XML: environment problems are <error>, functional mismatches <failure>, display differences properties (or failures when visualGate). */
export function renderJUnit(reports: CompareReport[]): string {
  const suites = reports.map((r) => {
    const groups = new Map<string, Difference[]>();
    for (const d of r.differences) groups.set(`${d.kind}:${d.key}`, [...(groups.get(`${d.kind}:${d.key}`) ?? []), d]);
    const cases: string[] = [`<testcase classname="${xml(r.scenario)}" name="functional-parity">${r.counts.environment ? `<error type="environment" message="${xml(r.differences.find((d) => d.category === 'environment')?.message)}"/>` : r.counts.functional ? `<failure type="functional" message="${r.counts.functional} functional difference(s)"/>` : ''}</testcase>`];
    for (const [name, list] of groups) {
      const d = list[0];
      const body = list.map((x) => `${x.message}${x.ie !== undefined ? `\nIE: ${x.ie}` : ''}${x.edge !== undefined ? `\nEdge: ${x.edge}` : ''}`).join('\n---\n');
      const tag = d.category === 'environment' ? `<error type="environment" message="${xml(d.message)}">${xml(body)}</error>`
        : d.category === 'functional' ? `<failure type="functional" message="${xml(d.message)}">${xml(body)}</failure>`
        : d.category === 'display' && !r.passed && r.status === 'display-difference' ? `<failure type="display" message="${xml(d.message)}">${xml(body)}</failure>`
        : `<system-out>${xml(`[${d.category}] ${body}`)}</system-out>`;
      cases.push(`<testcase classname="${xml(r.scenario)}" name="${xml(name)}">${tag}</testcase>`);
    }
    const failures = cases.filter((c) => c.includes('<failure')).length, errors = cases.filter((c) => c.includes('<error')).length;
    return `<testsuite name="${xml(r.scenario)}" tests="${cases.length}" failures="${failures}" errors="${errors}" timestamp="${xml(r.createdAt)}"><properties><property name="status" value="${xml(r.status)}"/><property name="baselineRunId" value="${xml(r.baseline.runId)}"/><property name="edgeRunId" value="${xml(r.edgeRun.runId)}"/><property name="mock" value="${!!(r.baseline.mock || r.edgeRun.mock)}"/></properties>${cases.join('')}</testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>${suites.join('')}</testsuites>\n`;
}

// ---------------------------------------------------------------------------
// Aggregate migration report (npm run report)
// ---------------------------------------------------------------------------
export type Waiver = { id: string; reason: string; approvedBy: string };
export type WindowsVerification = 'verified-on-windows' | 'mock-only' | 'not-run';
export type ScenarioSummary = {
  scenario: string; compare: CompareReport | null; baselineLocked: boolean; windows: WindowsVerification; latestEdgeStatus: string | null;
};
export type MigrationReport = {
  reportId: string; createdAt: string;
  verdict: 'complete' | 'incomplete' | 'blocked';
  reasons: string[];
  scenarios: ScenarioSummary[];
  analysis: { analysisId: string; open: { P1: number; P2: number }; waived: number; total: number } | null;
  fixes: { attempts: number; passed: number; failed: number; reverted: number; blocked: number; open: number };
};

function loadWaivers(): Waiver[] {
  const file = path.join(root, 'config', 'waivers.json');
  if (!fs.existsSync(file)) return [];
  const data = readJson<{ waivers?: Waiver[] }>(file);
  return (data.waivers ?? []).filter((w) => w.id && w.reason && w.approvedBy);
}

export function buildMigrationReport(opts: { scenarios?: string[] } = {}): { report: MigrationReport; dir: string } {
  const names = opts.scenarios?.length ? opts.scenarios : listScenarios();
  const scenarios: ScenarioSummary[] = names.map((name) => {
    const pointer = path.join(artifactsRoot(), 'compare', name, 'latest.json');
    let compare: CompareReport | null = null;
    if (fs.existsSync(pointer)) {
      const { compareId } = readJson<{ compareId: string }>(pointer);
      const f = path.join(artifactsRoot(), 'compare', name, compareId, 'report.json');
      if (fs.existsSync(f)) compare = readJson<CompareReport>(f);
    }
    const ie = latestRun('ie', name);
    const windows: WindowsVerification = !ie ? 'not-run' : ie.result.environment.realWindows && !ie.result.environment.mock ? 'verified-on-windows' : 'mock-only';
    return { scenario: name, compare, baselineLocked: !!readLock(name), windows, latestEdgeStatus: latestRun('edge', name)?.result.status ?? null };
  });
  const reasons: string[] = [];
  let blocked = false;
  for (const s of scenarios) {
    if (!s.compare) { reasons.push(`${s.scenario}: not compared yet`); continue; }
    if (s.compare.status === 'environment-error') { blocked = true; reasons.push(`${s.scenario}: environment error`); }
    else if (!s.compare.passed) reasons.push(`${s.scenario}: ${s.compare.status}`);
    if (!s.baselineLocked) reasons.push(`${s.scenario}: baseline not locked`);
    if (s.windows !== 'verified-on-windows') reasons.push(`${s.scenario}: IE baseline not verified on real Windows (${s.windows})`);
  }
  let analysis: MigrationReport['analysis'] = null;
  const pointer = path.join(artifactsRoot(), 'analysis', 'latest.json');
  if (fs.existsSync(pointer)) {
    const { analysisId } = readJson<{ analysisId: string }>(pointer);
    const file = path.join(artifactsRoot(), 'analysis', analysisId, 'findings.json');
    if (fs.existsSync(file)) {
      const a = readJson<AnalysisReport>(file);
      const waivers = new Set(loadWaivers().map((w) => w.id));
      const open = a.findings.filter((f) => f.classification === 'compat-issue' && !waivers.has(f.id));
      analysis = { analysisId, open: { P1: open.filter((f) => f.priority === 'P1').length, P2: open.filter((f) => f.priority === 'P2').length }, waived: a.findings.filter((f) => waivers.has(f.id)).length, total: a.findings.length };
      if (analysis.open.P1 + analysis.open.P2) reasons.push(`analysis: ${analysis.open.P1} P1 and ${analysis.open.P2} P2 compatibility issues remain (fix, or waive in config/waivers.json with approver)`);
    }
  }
  if (!analysis) reasons.push('analysis: not run (npm run analyze)');
  const fixIndex = path.join(artifactsRoot(), 'fixes', 'index.json');
  const attempts = fs.existsSync(fixIndex) ? readJson<{ attempts: Array<{ status: string }> }>(fixIndex).attempts : [];
  const cnt = (s: string) => attempts.filter((a) => a.status === s).length;
  const fixes = { attempts: attempts.length, passed: cnt('passed'), failed: cnt('failed'), reverted: cnt('reverted'), blocked: cnt('blocked'), open: attempts.filter((a) => ['open', 'applied', 'verified'].includes(a.status)).length };
  if (fixes.open) reasons.push(`fixes: ${fixes.open} attempt(s) still open`);
  const report: MigrationReport = {
    reportId: newRunId('report'), createdAt: new Date().toISOString(),
    verdict: blocked ? 'blocked' : reasons.length ? 'incomplete' : 'complete', reasons, scenarios, analysis, fixes,
  };
  const dir = path.join(artifactsRoot(), 'report', report.reportId);
  fs.mkdirSync(dir, { recursive: true });
  saveJson(path.join(dir, 'summary.json'), report);
  fs.writeFileSync(path.join(dir, 'index.html'), renderMigrationHtml(report), 'utf8');
  fs.writeFileSync(path.join(dir, 'junit.xml'), renderJUnit(scenarios.map((s) => s.compare).filter((c): c is CompareReport => !!c)), 'utf8');
  saveJson(path.join(artifactsRoot(), 'report', 'latest.json'), { reportId: report.reportId, verdict: report.verdict });
  return { report, dir };
}

export function renderMigrationHtml(r: MigrationReport): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Migration report</title><style>${STYLE}</style></head><body>
<h1>IE mode → Edge migration report <span class="badge ${esc(r.verdict)}">${esc(r.verdict)}</span></h1>
<p class="muted">${esc(r.reportId)} · ${esc(r.createdAt)}</p>
<h2>Open items</h2>${r.reasons.length ? `<ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="match">None - all completion criteria met.</p>'}
<h2>Scenarios</h2><table><tr><th>Scenario</th><th>Comparison</th><th>Functional</th><th>Display</th><th>Environment</th><th>Baseline</th><th>Windows verification</th><th>Report</th></tr>
${r.scenarios.map((s) => `<tr><td>${esc(s.scenario)}</td><td>${s.compare ? `<span class="badge ${esc(s.compare.status)}">${esc(s.compare.status)}</span>` : '<span class="muted">not compared</span>'}</td><td>${s.compare?.counts.functional ?? ''}</td><td>${s.compare?.counts.display ?? ''}</td><td>${s.compare?.counts.environment ?? ''}</td><td>${s.baselineLocked ? 'locked' : 'unlocked'}</td><td>${esc(s.windows)}</td><td>${s.compare ? `<a href="../../compare/${esc(s.scenario)}/${esc(s.compare.compareId)}/report.html">${esc(s.compare.compareId)}</a>` : ''}</td></tr>`).join('')}</table>
<h2>Static analysis</h2>${r.analysis ? `<p>${esc(r.analysis.analysisId)}: ${r.analysis.total} findings; open compat issues P1=${r.analysis.open.P1}, P2=${r.analysis.open.P2}; waived ${r.analysis.waived}. <a href="../../analysis/${esc(r.analysis.analysisId)}/summary.md">summary.md</a></p>` : '<p class="muted">Not run.</p>'}
<h2>Fix attempts</h2><p>${r.fixes.attempts} total · ${r.fixes.passed} passed · ${r.fixes.failed} failed · ${r.fixes.reverted} reverted · ${r.fixes.blocked} blocked · ${r.fixes.open} open</p>
</body></html>
`;
}
