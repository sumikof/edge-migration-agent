import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig, scenarioHash } from '../src/core.ts';
import { runIE } from '../src/ie.ts';
import { runEdge } from '../src/edge.ts';
import { compare } from '../src/compare.ts';
import { lockBaseline } from '../src/baseline.ts';
import { buildMigrationReport } from '../src/report.ts';
import { MockAdapter, orderSite, ORDER_SCENARIO, IE_ENGINE, EDGE_ENGINE, CHROME_ENGINE } from './helpers/mock-browser.mjs';
import { makeWorkspace, cleanup, baseConfig, writeScenario } from './helpers/workspace.mjs';

const ws = makeWorkspace();
after(() => cleanup(ws));
writeScenario(ws, ORDER_SCENARIO);
const config = parseConfig(baseConfig);
const ie = (variant = {}) => runIE(config, ORDER_SCENARIO, { adapterFactory: async () => new MockAdapter(orderSite(IE_ENGINE, { dialogMode: 'pending', ...variant })) });
const edge = (variant = {}, engine = EDGE_ENGINE) => runEdge(config, ORDER_SCENARIO, { adapterFactory: async () => new MockAdapter(orderSite(engine, variant)) }).catch((e) => e.result);
const run = (variant) => compare(config, 'order', { scenario: ORDER_SCENARIO }).then((r) => r.report);

let baselineRun;
beforeEach(async () => {
  if (!baselineRun) {
    baselineRun = await ie();
    lockBaseline('order', scenarioHash(ORDER_SCENARIO));
  }
});

test('identical behavior (dynamic timestamps masked) is a match', async () => {
  await edge({ resultText: '検索結果 3 件 (2026/10/27 08:00 現在)' });
  const r = await run();
  assert.equal(r.status, 'match', JSON.stringify(r.differences, null, 1));
  assert.equal(r.passed, true);
  assert.equal(r.baseline.locked, true);
  assert.equal(r.baseline.runId, baselineRun.runId);
});

test('business value difference is a functional mismatch', async () => {
  await edge({ amount: '1,200円' });
  const r = await run();
  assert.equal(r.status, 'functional-mismatch');
  assert.equal(r.passed, false);
  const d = r.differences.find((x) => x.key === 'amount');
  assert.equal(d.category, 'functional');
  assert.deepEqual([d.ie, d.edge], ['12,000円', '1,200円']);
  assert.deepEqual(r.textDiffs, ['amount'], 'starter field kept');
});

test('validation message difference is functional (validation-message)', async () => {
  await edge({ validation: '顧客コードが不正です' });
  const r = await run();
  assert.equal(r.differences.find((x) => x.key === 'validation').kind, 'validation-message');
  assert.equal(r.status, 'functional-mismatch');
});

test('DOM-only and image-only differences are display differences that still pass', async () => {
  await edge({ dom: '<table>\n  <tbody>\n    <tr>\n      #text "A001"', color: [0, 0, 0] });
  const r = await run();
  assert.equal(r.status, 'display-difference');
  assert.equal(r.passed, true, 'images/DOM are auxiliary unless visualGate');
  assert.ok(r.differences.some((d) => d.kind === 'dom' && d.category === 'display'));
  assert.ok(r.images.some((i) => i.status === 'different'));
  const gated = parseConfig({ ...baseConfig, compare: { visualGate: true } });
  const r2 = (await compare(gated, 'order', {})).report;
  assert.equal(r2.passed, false);
});

test('Edge page errors fail functionally; network errors are warnings', async () => {
  await edge({ diagnostics: { pageErrors: ['TypeError: el.attachEvent is not a function'], network: ['GET /x.gif HTTP 404'] } });
  const r = await run();
  assert.equal(r.status, 'functional-mismatch');
  assert.equal(r.differences.find((d) => d.kind === 'page-error').category, 'functional');
  assert.equal(r.differences.find((d) => d.kind === 'network').category, 'warning');
});

test('Edge step failure is functional and reports unreached steps', async () => {
  await runEdge(config, ORDER_SCENARIO, { adapterFactory: async () => {
    const site = orderSite(EDGE_ENGINE);
    site.pages['/search'].frames['iframe#outer'].frames['iframe[name=inner]'].elements['xpath=//button[.="検索"]'].onClick = { throws: 'TypeError: window.showModalDialog is not a function' };
    return new MockAdapter(site);
  } }).catch(() => {});
  const r = await run();
  assert.equal(r.status, 'functional-mismatch');
  assert.ok(r.differences.some((d) => d.kind === 'step-failed' && /showModalDialog/.test(d.message)));
  assert.ok(r.differences.some((d) => d.kind === 'step-not-reached'));
});

test('engine mismatch is an environment error, not a functional one', async () => {
  await edge({}, CHROME_ENGINE);
  const r = await run();
  assert.equal(r.status, 'environment-error');
  assert.ok(r.differences.some((d) => d.kind === 'engine-mismatch'));
});

test('Edge run recorded against another baseline is refused as stale', async () => {
  await runEdge(config, ORDER_SCENARIO, { baselineId: 'ie-old-run', adapterFactory: async () => new MockAdapter(orderSite(EDGE_ENGINE)) });
  const r = await run();
  assert.equal(r.status, 'environment-error');
  assert.ok(r.differences.some((d) => d.kind === 'baseline-mismatch'));
});

test('changed scenario definition invalidates the baseline', async () => {
  await edge();
  const changed = { ...ORDER_SCENARIO, steps: [...ORDER_SCENARIO.steps, { op: 'captureUrl', key: 'u' }] };
  const r = (await compare(config, 'order', { scenario: changed })).report;
  assert.ok(r.differences.some((d) => d.kind === 'stale-baseline'));
  assert.equal(r.status, 'environment-error');
});

test('tampered baseline is detected', async () => {
  await edge();
  const lock = JSON.parse(fs.readFileSync(path.join(ws.artifacts, 'baselines', 'order.json'), 'utf8'));
  const file = path.join(ws.artifacts, 'ie', 'order', lock.runId, 'detail.png');
  fs.chmodSync(file, 0o644);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from([0])]));
  const r = await run();
  assert.ok(r.differences.some((d) => d.kind === 'baseline-tampered'));
  fs.writeFileSync(file, original);
});

test('HTML and JUnit reports are generated with categories', async () => {
  await edge({ amount: '1円' });
  const { dir, report } = await compare(config, 'order', {});
  const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
  const junit = fs.readFileSync(path.join(dir, 'junit.xml'), 'utf8');
  assert.match(html, /functional-mismatch/);
  assert.ok(!html.includes('<script'), 'no scripts in report');
  assert.match(junit, /^<\?xml/);
  assert.match(junit, /<failure type="functional"/);
  assert.equal(report.counts.functional > 0, true);
});

test('aggregate report: verdict, Windows verification classification and JUnit', async () => {
  await edge();
  await run();
  const { report, dir } = buildMigrationReport({ scenarios: ['order'] });
  assert.equal(report.scenarios[0].windows, 'mock-only', 'mock runs are never reported as Windows-verified');
  assert.equal(report.verdict, 'incomplete');
  assert.ok(report.reasons.some((r) => /not verified on real Windows/.test(r)));
  assert.ok(report.reasons.some((r) => /analysis: not run/.test(r)));
  for (const f of ['index.html', 'summary.json', 'junit.xml']) assert.ok(fs.existsSync(path.join(dir, f)));
});
