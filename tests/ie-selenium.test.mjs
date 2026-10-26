// Exercises the real SeleniumIEAdapter (src/ie.ts) against a fake WebDriver.
// This verifies the Selenium API usage; it is NOT a substitute for a run on Windows IE mode.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { parseConfig, parseScenario } from '../src/core.ts';
import { runIE, SeleniumIEAdapter, acquireIELock } from '../src/ie.ts';
import { FakeDriver } from './helpers/fake-webdriver.mjs';
import { makeWorkspace, cleanup, baseConfig } from './helpers/workspace.mjs';

const require = createRequire(import.meta.url);
const webdriver = require('selenium-webdriver');
const ws = makeWorkspace('ema-se-');
after(() => cleanup(ws));
const config = parseConfig({ ...baseConfig, ieBaseUrl: 'http://legacy.test.local/app/' });

const site = {
  engine: { documentMode: 5, userAgent: 'Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 10.0; Trident/7.0)', brands: [] },
  pages: {
    '/app/menu.jsp': {
      title: 'メニュー',
      elements: {},
      frames: {
        'frame[name=main]': {
          elements: { '#title': { text: '受注検索' } },
          frames: {
            'xpath=//iframe[@id="search"]': {
              elements: {
                '#customer': { id: 'customer', value: '' },
                '#status': { id: 'status', options: [{ value: '1', label: '受付' }, { value: '2', label: '出荷済' }], value: '1' },
                '#closed': { id: 'closed', type: 'checkbox', checked: false },
                'xpath=//input[@value="検索"]': { id: 'search', onClick: { alert: '検索しますか？', setText: { '#count': '3 件' } } },
                '#count': { text: '' },
                '#detail': { id: 'detail', onClick: { openWindow: '/app/detail.jsp' } },
              },
            },
          },
        },
      },
    },
    '/app/detail.jsp': { title: '受注詳細', elements: { '#amount': { text: '12,000円' } } },
  },
};
const F = ['frame[name=main]', 'xpath=//iframe[@id="search"]'];
const scenario = parseScenario({
  name: 'se-order',
  steps: [
    { op: 'navigate', path: 'menu.jsp' },
    { op: 'captureText', frame: 'frame[name=main]', selector: '#title', key: 'title' },
    { op: 'fill', frame: F, selector: '#customer', value: 'C0001' },
    { op: 'assertValue', frame: F, selector: '#customer', value: 'C0001' },
    { op: 'select', frame: F, selector: '#status', label: '出荷済' },
    { op: 'captureValue', frame: F, selector: '#status', key: 'status' },
    { op: 'check', frame: F, selector: '#closed' },
    { op: 'assertChecked', frame: F, selector: '#closed' },
    { op: 'click', frame: F, xpath: '//input[@value="検索"]' },
    { op: 'dialog', action: 'accept', key: 'confirm' },
    { op: 'waitText', frame: F, selector: '#count', text: '件' },
    { op: 'captureFormState', frame: F, selector: '#customer', key: 'form' },
    { op: 'press', value: 'Enter' },
    { op: 'click', frame: F, selector: '#detail' },
    { op: 'switchWindow', titleContains: '詳細' },
    { op: 'captureText', selector: '#amount', key: 'amount' },
    { op: 'screenshot', name: 'detail' },
    { op: 'closeWindow' },
  ],
});

test('SeleniumIEAdapter drives nested frames (CSS + XPath), select, checkbox, alert, windows', async () => {
  const driver = new FakeDriver(site);
  const r = await runIE(config, scenario, { adapterFactory: async () => new SeleniumIEAdapter(driver, webdriver) });
  assert.equal(r.status, 'passed', JSON.stringify(r.error));
  assert.equal(r.engine.verified, true);
  assert.equal(r.engine.pages[0].documentMode, 5);
  assert.equal(r.captures.title, '受注検索');
  assert.equal(r.captures.status, '2');
  assert.equal(r.captures.confirm, '検索しますか？');
  assert.equal(r.captures.amount, '12,000円');
  assert.ok(driver.log.includes('accept'));
  assert.ok(driver.quitCalled);
  assert.deepEqual(r.urls.map((u) => u.url), ['/app/menu.jsp', '/app/detail.jsp', '/app/menu.jsp']);
  assert.ok(r.diagnostics.notes.some((n) => /window.onerror/.test(n)), 'IE diagnostic limitations are reported');
});

test('an unanswered alert in IE fails the step as unexpected-dialog', async () => {
  const s = parseScenario({ name: 'se-alert', steps: [{ op: 'navigate', path: 'menu.jsp' }, { op: 'click', frame: F, xpath: '//input[@value="検索"]' }, { op: 'captureText', frame: F, selector: '#count', key: 'c' }] });
  await assert.rejects(() => runIE(config, s, { adapterFactory: async () => new SeleniumIEAdapter(new FakeDriver(site), webdriver) }), (e) => {
    assert.equal(e.result.error.kind, 'unexpected-dialog');
    return true;
  });
});

test('missing element in IE is a functional timeout, not an environment error', async () => {
  const s = parseScenario({ name: 'se-missing', steps: [{ op: 'navigate', path: 'menu.jsp' }, { op: 'click', frame: F, selector: '#nope', timeoutMs: 200 }] });
  await assert.rejects(() => runIE(config, s, { adapterFactory: async () => new SeleniumIEAdapter(new FakeDriver(site), webdriver) }), (e) => {
    assert.equal(e.result.status, 'failed');
    assert.equal(e.result.error.kind, 'timeout');
    return true;
  });
});

test('real launch outside Windows is reported as an environment error', async () => {
  await assert.rejects(() => SeleniumIEAdapter.launch(config), (e) => {
    if (process.platform === 'win32') return true;
    assert.equal(e.kind, 'environment');
    assert.match(e.message, /native Windows/);
    return true;
  });
});

test('IE runs are serialized with a lock file', () => {
  const release = acquireIELock();
  try {
    // Same process re-acquiring is allowed (stale/own lock); a live foreign pid would be refused.
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(path.join(ws.artifacts, '.locks', 'ie.lock'), String(process.ppid));
    assert.throws(() => acquireIELock(), /Another IE-mode run is active/);
  } finally { release(); }
});
