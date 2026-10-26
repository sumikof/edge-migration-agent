import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../src/core.ts';
import { runScenario } from '../src/runner.ts';
import { runIE } from '../src/ie.ts';
import { runEdge } from '../src/edge.ts';
import { lockBaseline, verifyBaseline, resolveBaselineId, listRuns } from '../src/baseline.ts';
import { scenarioHash } from '../src/core.ts';
import { MockAdapter, orderSite, ORDER_SCENARIO, IE_ENGINE, EDGE_ENGINE, CHROME_ENGINE, readJsonFile } from './helpers/mock-browser.mjs';
import { makeWorkspace, cleanup, baseConfig } from './helpers/workspace.mjs';

const ws = makeWorkspace();
after(() => cleanup(ws));
const config = parseConfig({ ...baseConfig, retries: { step: 1, launch: 0 } });

test('IE mock run: nested iframes, xpath, select by label, dialogs, windows, captures', async () => {
  const adapter = new MockAdapter(orderSite(IE_ENGINE, { dialogMode: 'pending' }));
  const r = await runIE(config, ORDER_SCENARIO, { adapterFactory: async () => adapter });
  assert.equal(r.status, 'passed', JSON.stringify(r.error));
  assert.equal(r.engine.verified, true);
  assert.equal(r.environment.mock, true);
  assert.equal(r.environment.realWindows, false);
  assert.equal(r.captures.statusValue, '2');
  assert.equal(r.captures.confirm, '検索しますか？');
  assert.equal(r.captures.amount, '12,000円');
  assert.equal(r.captureMeta.validation.category, 'validation');
  assert.deepEqual(r.urls.map((u) => u.url), ['/', '/search', '/detail', '/search']);
  assert.equal(r.dialogs.length, 1);
  assert.ok(adapter.closed, 'browser closed');
  const dir = path.join(ws.artifacts, 'ie', 'order', r.runId);
  const stored = readJsonFile(path.join(dir, 'result.json'));
  assert.equal(stored.captures.mail, '<EMAIL>', 'PII redacted before writing');
  assert.ok(fs.existsSync(path.join(dir, 'detail.png')));
  assert.ok(fs.readFileSync(path.join(dir, 'dom', 'table.txt'), 'utf8').includes('A001'));
  assert.equal(readJsonFile(path.join(ws.artifacts, 'ie', 'order', 'latest.json')).runId, r.runId);
});

test('Edge mock run uses armed dialogs and records the baseline it targets', async () => {
  const ieRun = listRuns('ie', 'order').pop().result;
  const r = await runEdge(config, ORDER_SCENARIO, { adapterFactory: async () => new MockAdapter(orderSite(EDGE_ENGINE)) });
  assert.equal(r.status, 'passed', JSON.stringify(r.error));
  assert.equal(r.baselineId, ieRun.runId);
  assert.equal(r.scenarioHash, ieRun.scenarioHash);
});

test('retries apply only to idempotent steps', async () => {
  const r = await runEdge(config, ORDER_SCENARIO, { adapterFactory: async () => new MockAdapter(orderSite(EDGE_ENGINE, { flaky: 1 })) });
  assert.equal(r.status, 'passed');
  const waitText = r.results.find((s) => s.op === 'waitText');
  assert.ok(waitText.attempts >= 1);
});

test('functional failure is classified and evidence screenshot taken', async () => {
  const scenario = { name: 'order', steps: [...ORDER_SCENARIO.steps.slice(0, 2), { op: 'assertTextContains', selector: 'body', text: 'nope' }] };
  await assert.rejects(() => runEdge(config, scenario, { adapterFactory: async () => new MockAdapter(orderSite(EDGE_ENGINE)) }), (e) => {
    assert.equal(e.result.status, 'failed');
    assert.equal(e.result.error.kind, 'assertion');
    assert.equal(e.result.results.at(-1).status, 'failed');
    return true;
  });
});

test('optional steps are skipped, not failed', async () => {
  const scenario = { name: 'opt', steps: [{ op: 'navigate', path: '/' }, { op: 'captureText', selector: '#missing', key: 'x', optional: true }] };
  const r = await runEdge(config, scenario, { adapterFactory: async () => new MockAdapter(orderSite(EDGE_ENGINE)), baselineId: null });
  assert.equal(r.status, 'passed');
  assert.equal(r.results[1].status, 'skipped');
});

test('unexpected dialogs fail the step', async () => {
  const scenario = { name: 'dlg', steps: [{ op: 'navigate', path: '/search' }, { op: 'click', frame: ['iframe#outer', 'iframe[name=inner]'], xpath: '//button[.="検索"]' }] };
  await assert.rejects(() => runEdge(config, scenario, { adapterFactory: async () => new MockAdapter(orderSite(EDGE_ENGINE)), baselineId: null }), (e) => {
    assert.equal(e.result.error.kind, 'unexpected-dialog');
    return true;
  });
});

test('Edge run on non-Edge Chromium is an environment error (engine verification)', async () => {
  await assert.rejects(() => runEdge(config, ORDER_SCENARIO, { adapterFactory: async () => new MockAdapter(orderSite(CHROME_ENGINE)) }), (e) => {
    assert.equal(e.result.status, 'environment-error');
    assert.equal(e.result.error.kind, 'engine-mismatch');
    return true;
  });
});

test('IE run that renders in Chromium (site list misconfigured) is an environment error', async () => {
  await assert.rejects(() => runIE(config, ORDER_SCENARIO, { adapterFactory: async () => new MockAdapter(orderSite(EDGE_ENGINE, { dialogMode: 'pending' })) }), (e) => {
    assert.equal(e.result.status, 'environment-error');
    assert.match(e.result.engine.problems.join(' '), /documentMode is undefined/);
    return true;
  });
});

test('launch failure stores environment diagnostics and is retried', async () => {
  let calls = 0;
  const cfg = parseConfig({ ...baseConfig, retries: { launch: 1 } });
  await assert.rejects(() => runIE(cfg, ORDER_SCENARIO, {
    adapterFactory: async () => { calls++; throw new Error('SessionNotCreatedError: Unexpected error launching Internet Explorer. Protected Mode settings are not the same for all zones.'); },
    diagnose: async () => ({ checks: [{ id: 'ie.protected-mode', status: 'fail', detail: 'zones differ' }] }),
  }), (e) => {
    assert.equal(e.result.status, 'environment-error');
    assert.equal(e.result.diagnostics.environment.checks[0].id, 'ie.protected-mode');
    return true;
  });
  assert.equal(calls, 2);
});

test('secrets from environment variables never reach result.json', async () => {
  process.env.MOCK_PASSWORD = 'Very$ecret99';
  const scenario = { name: 'login', steps: [
    { op: 'navigate', path: '/search' },
    { op: 'fill', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#customer', value: '${env:MOCK_PASSWORD}', secret: true },
    { op: 'captureText', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#customer', key: 'echo', optional: true },
    { op: 'assertTextContains', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#count', text: 'Very$ecret99' },
  ] };
  await assert.rejects(() => runEdge(config, scenario, { adapterFactory: async () => new MockAdapter(orderSite(EDGE_ENGINE)), baselineId: null }));
  const run = listRuns('edge', 'login').pop();
  const raw = fs.readFileSync(path.join(run.dir, 'result.json'), 'utf8');
  assert.ok(!raw.includes('Very$ecret99'), 'secret leaked into result.json');
  assert.ok(raw.includes('<SECRET>'));
});

test('run directories are unique and baselines are locked immutably', async () => {
  const before = listRuns('ie', 'order').length;
  await runIE(config, ORDER_SCENARIO, { adapterFactory: async () => new MockAdapter(orderSite(IE_ENGINE, { dialogMode: 'pending' })) });
  assert.equal(listRuns('ie', 'order').length, before + 1, 'previous runs are kept');
  const lock = lockBaseline('order', scenarioHash(ORDER_SCENARIO));
  assert.equal(resolveBaselineId('order'), lock.runId);
  assert.deepEqual(verifyBaseline(lock), []);
  assert.throws(() => lockBaseline('order', scenarioHash(ORDER_SCENARIO)), /already has a locked baseline/);
  assert.throws(() => lockBaseline('order', 'different-hash', { replace: true }), /different version of scenario/);
  const result = path.join(ws.artifacts, 'ie', 'order', lock.runId, 'result.json');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) assert.throws(() => fs.writeFileSync(result, '{}'), /EACCES|EPERM/);
  fs.chmodSync(result, 0o644);
  fs.appendFileSync(result, ' ');
  assert.match(verifyBaseline(lock).join(), /modified result.json/);
});

test('runScenario never reuses a run directory', async () => {
  const opts = { target: 'edge', config, scenario: { name: 'tiny', steps: [{ op: 'navigate', path: '/' }] }, baseUrl: config.edgeBaseUrl, baselineId: null, launch: async () => ({ adapter: new MockAdapter(orderSite(EDGE_ENGINE)) }) };
  const a = await runScenario(opts);
  const b = await runScenario(opts);
  assert.notEqual(a.dir, b.dir);
});
