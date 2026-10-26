// In-memory BrowserAdapter used for integration tests without real browsers.
// A "site" maps paths to pages; pages contain elements (keyed by selector or
// "xpath=...") and nested frames (keyed by frame selector).
import fs from 'node:fs';
import sharp from 'sharp';
import { DOM_SNAPSHOT, ENGINE_INFO, ERROR_DRAIN, FORM_STATE } from '../../src/page-scripts.ts';
import { HarnessError } from '../../src/runner.ts';

export const IE_ENGINE = { documentMode: 8, userAgent: 'Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 10.0; Trident/7.0)', brands: [] };
export const EDGE_ENGINE = { documentMode: null, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0', brands: ['Microsoft Edge', 'Chromium'] };
export const CHROME_ENGINE = { documentMode: null, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', brands: ['Google Chrome'] };

const clone = (v) => JSON.parse(JSON.stringify(v));

export class MockAdapter {
  /** @param {{ engine: object, pages: Record<string, any>, dialogMode?: 'armed'|'pending', color?: number[], diagnostics?: object, failLaunch?: boolean }} site */
  constructor(site) {
    this.site = site;
    this.windows_ = [];
    this.seq = 0;
    this.current = null;
    this.armed = undefined;
    this.handled = [];
    this.pending = null;
    this.unexpected = [];
    this.log = [];
  }
  open(url) {
    const w = { id: `w${this.seq++}`, url, page: null };
    this.windows_.push(w);
    this.load(w, url);
    return w;
  }
  load(w, url) {
    const p = new URL(url).pathname;
    const page = this.site.pages[p];
    if (!page) throw new HarnessError('environment', `net::ERR_CONNECTION_REFUSED at ${url}`);
    w.url = url;
    w.page = clone(page);
  }
  scope(loc) {
    let node = this.current.page;
    for (const f of loc.frames) {
      node = node.frames?.[f];
      if (!node) throw new HarnessError('timeout', `frame ${f} not found`);
    }
    return node;
  }
  el(loc) {
    const key = loc.xpath ? `xpath=${loc.xpath}` : loc.selector;
    const e = this.scope(loc).elements?.[key];
    if (!e) throw new HarnessError('timeout', `element ${key} not found`);
    if (e.flaky > 0) { e.flaky--; throw new HarnessError('timeout', `element ${key} not ready`); }
    return e;
  }
  async navigate(url) { this.log.push(['navigate', url]); if (!this.current) this.current = this.open(url); else this.load(this.current, url); }
  async waitFor(loc, state) {
    if (state === 'hidden') { let e; try { e = this.el(loc); } catch { return; } if (e.visible === false) return; throw new HarnessError('timeout', 'still visible'); }
    const e = this.el(loc);
    if (e.visible === false) throw new HarnessError('timeout', 'not visible');
  }
  async click(loc) {
    const e = this.el(loc);
    this.log.push(['click', loc.selector ?? loc.xpath]);
    const a = e.onClick ?? {};
    if (a.setText) for (const [sel, text] of Object.entries(a.setText)) this.scope(loc).elements[sel].text = text;
    if (a.openWindow) { const base = new URL(this.current.url); this.open(new URL(a.openWindow, base).href); }
    if (a.dialog) this.raiseDialog(a.dialog);
    if (a.navigate) this.load(this.current, new URL(a.navigate, this.current.url).href);
    if (a.throws) throw new HarnessError('script', a.throws);
  }
  raiseDialog(d) {
    if (this.site.dialogMode === 'pending') { this.pending = d; return; }
    const spec = this.armed; this.armed = undefined;
    if (spec) this.handled.push({ type: d.type, message: d.message, action: spec.action });
    else this.unexpected.push({ type: d.type, message: d.message });
  }
  async fill(loc, value) { this.el(loc).value = value; }
  async select(loc, choice) {
    const e = this.el(loc);
    const opt = (e.options ?? []).find((o, i) => (choice.value !== undefined ? o.value === choice.value : choice.label !== undefined ? o.label === choice.label : i === choice.index));
    if (!opt) throw new HarnessError('timeout', 'option not found');
    e.value = opt.value;
  }
  async setChecked(loc, checked) { this.el(loc).checked = checked; }
  async press(loc, key) { this.log.push(['press', key]); }
  async text(loc) { return this.el(loc).text ?? ''; }
  async value(loc) { return this.el(loc).value ?? ''; }
  async attribute(loc, name) { return this.el(loc).attrs?.[name] ?? null; }
  async isChecked(loc) { return !!this.el(loc).checked; }
  async isVisible(loc) { try { return this.el(loc).visible !== false; } catch { return false; } }
  async evalElement(loc, fn) {
    const e = this.el(loc);
    if (fn === FORM_STATE) return JSON.stringify(e.formState ?? [{ tag: 'input', type: 'text', name: loc.selector, value: e.value ?? '' }]);
    if (fn === DOM_SNAPSHOT) return e.dom ?? `<div>\n  #text "${e.text ?? ''}"`;
    throw new Error('unsupported script');
  }
  async evalPage(fn) {
    if (fn === ENGINE_INFO) {
      const eng = this.site.engine;
      return JSON.stringify({ ...eng, compatMode: 'CSS1Compat', hasActiveX: eng.documentMode !== null, documentAllType: eng.documentMode ? 'object' : 'undefined', charset: 'UTF-8', url: this.current.url, title: this.current.page.title ?? '' });
    }
    if (fn === ERROR_DRAIN) return '[]';
    throw new Error('unsupported script');
  }
  async url() { return this.current.url; }
  async screenshot(file, mask) {
    const [r, g, b] = this.site.color ?? [255, 255, 255];
    await sharp({ create: { width: 40, height: 30, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toFile(file);
    return { masked: this.site.dialogMode !== 'pending' };
  }
  async windows() { return this.windows_.map((w) => ({ id: w.id, url: w.url, title: w.page?.title ?? '', current: w === this.current })); }
  async switchWindow(id) { this.current = this.windows_.find((w) => w.id === id); }
  async closeWindow() { this.windows_ = this.windows_.filter((w) => w !== this.current); this.current = this.windows_[0]; }
  armDialog(spec) { if (this.site.dialogMode !== 'pending') this.armed = spec; }
  async handleDialog(spec) {
    if (this.site.dialogMode === 'pending') {
      if (!this.pending) throw new HarnessError('timeout', 'No dialog appeared');
      const d = this.pending; this.pending = null;
      return { type: d.type, message: d.message, action: spec.action };
    }
    const d = this.handled.shift();
    if (!d) throw new HarnessError('timeout', 'No dialog appeared');
    return d;
  }
  async takeUnexpectedDialogs() {
    if (this.site.dialogMode === 'pending' && this.pending) { const d = this.pending; this.pending = null; return [{ type: d.type, message: d.message }]; }
    const l = this.unexpected; this.unexpected = []; return l;
  }
  async afterStep() {}
  async drainDiagnostics() { return clone(this.site.diagnostics ?? {}); }
  async browserVersion() { return 'mock 1.0'; }
  async close() { this.closed = true; }
}

/** A small business site used by several tests. Variants simulate Edge-side regressions. */
export function orderSite(engine, variant = {}) {
  const resultText = variant.resultText ?? '検索結果 3 件 (2026/10/26 10:15 現在)';
  return {
    engine,
    dialogMode: variant.dialogMode ?? 'armed',
    color: variant.color,
    diagnostics: variant.diagnostics,
    pages: {
      '/': { title: 'Menu', elements: { body: { text: 'menu' }, '#toSearch': { text: '受注検索', onClick: { navigate: '/search' } } } },
      '/search': {
        title: 'Search',
        elements: { body: { text: 'search' } },
        frames: {
          'iframe#outer': {
            frames: {
              'iframe[name=inner]': {
                elements: {
                  '#customer': { value: '' },
                  '#status': { options: [{ value: '1', label: '受付' }, { value: '2', label: '出荷済' }], value: '1' },
                  '#closed': { checked: false },
                  'xpath=//button[.="検索"]': { text: '検索', onClick: { dialog: { type: 'confirm', message: '検索しますか？' }, setText: { '#count': resultText, '#msg': variant.validation ?? '' } } },
                  '#count': { text: '', flaky: variant.flaky ?? 0 },
                  '#msg': { text: '' },
                  '#detail': { text: '詳細', onClick: { openWindow: '/detail' } },
                  '#table': { text: 'x', dom: variant.dom ?? '<table>\n  <tr>\n    <td>\n      #text "A001"' },
                },
              },
            },
          },
        },
      },
      '/detail': { title: 'Order detail', elements: { '#amount': { text: variant.amount ?? '12,000円' }, '#mail': { text: 'taro@example.com' } } },
    },
  };
}

export const ORDER_SCENARIO = {
  name: 'order',
  steps: [
    { op: 'navigate', path: '/' },
    { op: 'waitVisible', selector: 'body' },
    { op: 'click', selector: '#toSearch' },
    { op: 'waitUrl', urlContains: '/search' },
    { op: 'fill', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#customer', value: 'C0001' },
    { op: 'select', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#status', label: '出荷済' },
    { op: 'check', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#closed' },
    { op: 'captureValue', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#status', key: 'statusValue' },
    { op: 'click', frame: ['iframe#outer', 'iframe[name=inner]'], xpath: '//button[.="検索"]' },
    { op: 'dialog', action: 'accept', text: '検索', key: 'confirm' },
    { op: 'waitText', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#count', text: '件' },
    { op: 'captureText', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#count', key: 'count' },
    { op: 'captureText', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#msg', key: 'validation', category: 'validation' },
    { op: 'captureDom', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#table', key: 'table' },
    { op: 'click', frame: ['iframe#outer', 'iframe[name=inner]'], selector: '#detail' },
    { op: 'switchWindow', urlContains: '/detail' },
    { op: 'captureText', selector: '#amount', key: 'amount' },
    { op: 'captureText', selector: '#mail', key: 'mail' },
    { op: 'screenshot', name: 'detail' },
    { op: 'closeWindow' },
    { op: 'screenshot', name: 'search' },
  ],
};

export function writePng(file, rgb) {
  const [r, g, b] = rgb;
  return sharp({ create: { width: 40, height: 30, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toFile(file);
}
export function readJsonFile(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
