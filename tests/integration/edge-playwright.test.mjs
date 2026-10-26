// Runs the real PlaywrightAdapter against a local fixture site.
// On Windows with Microsoft Edge installed it uses channel "msedge" and requires the Edge brand;
// elsewhere it falls back to a local Chromium binary (engine brand check relaxed) or skips.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseConfig, parseScenario } from '../../src/core.ts';
import { runEdge } from '../../src/edge.ts';
import { locateEdge } from '../../src/ie.ts';
import { makeWorkspace, cleanup, baseConfig, repoRoot } from '../helpers/workspace.mjs';

const webRoot = path.join(repoRoot, 'tests', 'fixtures', 'web');
const edgePath = process.platform === 'win32' ? locateEdge() : undefined;
const chromiumPath = [process.env.PW_CHROMIUM_PATH, '/opt/pw-browsers/chromium'].find((p) => p && fs.existsSync(p));
const launchOverride = edgePath ? undefined : chromiumPath ? { executablePath: chromiumPath, headless: true } : undefined;
const skip = !edgePath && !chromiumPath ? 'no Microsoft Edge or Chromium binary available' : false;

let server, ws, config;
const posts = [];
before(async () => {
  ws = makeWorkspace('ema-pw-');
  server = http.createServer((req, res) => {
    if (req.method !== 'GET') { posts.push(`${req.method} ${req.url}`); res.writeHead(200); res.end('saved'); return; }
    const name = req.url === '/' ? 'index.html' : path.basename(new URL(req.url, 'http://x').pathname);
    const file = path.join(webRoot, name);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('missing'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  config = parseConfig({ ...baseConfig, ieBaseUrl: url, edgeBaseUrl: url, timeoutMs: 5000, edge: { headless: true, requireEdgeBrand: !!edgePath } });
});
after(() => { server?.close(); if (ws) cleanup(ws); });

const F = ['iframe#outer', 'iframe[name=inner]'];
const scenario = parseScenario({
  name: 'pw-order',
  steps: [
    { op: 'navigate', path: '/' },
    { op: 'waitVisible', selector: 'h1' },
    { op: 'captureText', selector: 'h1', key: 'heading' },
    { op: 'click', selector: '#toSearch' },
    { op: 'waitUrl', urlContains: 'frames.html' },
    { op: 'fill', frame: F, selector: '#customer', value: 'C0001' },
    { op: 'fill', frame: F, selector: '#pw', value: '${env:PW_TEST_SECRET}', secret: true },
    { op: 'select', frame: F, selector: '#status', label: '出荷済' },
    { op: 'check', frame: F, selector: '#closed' },
    { op: 'assertChecked', frame: F, selector: '#closed' },
    { op: 'assertValue', frame: F, selector: '#status', value: '2' },
    { op: 'captureFormState', frame: F, selector: 'form#search', key: 'form' },
    { op: 'click', frame: F, xpath: '//button[normalize-space(.)="検索"]' },
    { op: 'dialog', action: 'accept', text: '検索', key: 'confirm' },
    { op: 'waitText', frame: F, selector: '#count', text: '件' },
    { op: 'captureText', frame: F, selector: '#count', key: 'count' },
    { op: 'captureText', frame: F, selector: '#msg', key: 'validation', category: 'validation' },
    { op: 'captureDom', frame: F, selector: '#table', key: 'table' },
    { op: 'click', frame: F, selector: '#detail' },
    { op: 'switchWindow', urlContains: 'detail.html' },
    { op: 'captureText', selector: '#amount', key: 'amount' },
    { op: 'screenshot', name: 'detail', mask: ['#mail'] },
    { op: 'closeWindow' },
    { op: 'click', frame: F, selector: '#save' },
    { op: 'wait', ms: 800 },
    { op: 'captureUrl', key: 'finalUrl' },
  ],
});

test('real browser: frames, xpath, dialog, async wait, popup window, DOM/form capture, safety', { skip }, async () => {
  process.env.PW_TEST_SECRET = 'TopSecret#42';
  const r = await runEdge(config, scenario, { launchOverride, baselineId: null });
  assert.equal(r.status, 'passed', JSON.stringify(r.error));
  assert.equal(r.engine.verified, true);
  assert.equal(r.engine.pages[0].documentMode, null, 'Chromium, not IE mode');
  assert.equal(r.captures.heading, '業務メニュー');
  assert.equal(r.captures.confirm, '検索しますか？');
  assert.match(r.captures.count, /検索結果 3 件/);
  assert.equal(r.captures.amount, '12,000円');
  assert.equal(r.captures.finalUrl, '/frames.html');
  const form = JSON.parse(r.captures.form);
  assert.deepEqual(form.find((f) => f.name === 'status').selected, ['2|出荷済']);
  assert.equal(form.find((f) => f.name === 'closed').checked, true);
  assert.equal(form.find((f) => f.name === 'pw').value, '<password>', 'password values are never captured');
  const runDir = path.join(ws.artifacts, 'edge', 'pw-order', r.runId);
  const dom = fs.readFileSync(path.join(runDir, 'dom', 'table.txt'), 'utf8');
  assert.match(dom, /<td>\n\s+#text "A001"/);
  assert.ok(!/style=/.test(dom), 'style attributes are ignored for cross-engine DOM comparison');
  assert.ok(r.diagnostics.console.some((c) => c.includes('legacy console error')));
  assert.ok(r.diagnostics.blockedRequests.some((b) => b.startsWith('POST') && b.includes('/save')), JSON.stringify(r.diagnostics));
  assert.deepEqual(posts, [], 'mutating request never reached the server');
  assert.ok(!fs.readFileSync(path.join(runDir, 'result.json'), 'utf8').includes('TopSecret#42'));
  assert.ok(fs.existsSync(path.join(runDir, 'detail.png')));
});

test('real browser: uncaught IE-only API error is captured as a page error', { skip }, async () => {
  const s = parseScenario({ name: 'pw-broken', steps: [{ op: 'navigate', path: '/broken.html' }, { op: 'waitVisible', selector: '#p' }] });
  const r = await runEdge(config, s, { launchOverride, baselineId: null });
  assert.ok(r.diagnostics.pageErrors.some((e) => /attachEvent is not a function/.test(e)), JSON.stringify(r.diagnostics.pageErrors));
});

test('real browser: unreachable server is an environment error', { skip }, async () => {
  const cfg = parseConfig({ ...baseConfig, edgeBaseUrl: 'http://127.0.0.1:9/', timeoutMs: 3000, retries: { launch: 0 }, edge: { headless: true, requireEdgeBrand: !!edgePath } });
  const s = parseScenario({ name: 'pw-down', steps: [{ op: 'navigate', path: '/' }] });
  await assert.rejects(() => runEdge(cfg, s, { launchOverride, baselineId: null }), (e) => {
    assert.equal(e.result.status, 'environment-error');
    return true;
  });
});
