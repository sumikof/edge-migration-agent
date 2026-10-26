// Minimal fake of a selenium-webdriver WebDriver, enough to exercise SeleniumIEAdapter
// (frame switching, waits via `until`, alerts, windows, executeScript) without IE.
import { createRequire } from 'node:module';
import { DOM_SNAPSHOT, ENGINE_INFO, ERROR_DRAIN, FORM_STATE } from '../../src/page-scripts.ts';

const require = createRequire(import.meta.url);
const { error } = require('selenium-webdriver');
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function key(by) { return by.using === 'xpath' ? `xpath=${by.value}` : by.value; }

class FakeElement {
  constructor(driver, spec) { this.d = driver; this.s = spec; }
  async click() {
    this.d.log.push(`click ${this.s.id ?? ''}`);
    const a = this.s.onClick ?? {};
    if (this.s.optionOf) { this.s.optionOf.value = this.s.value; return; }
    if (this.s.type === 'checkbox') this.s.checked = !this.s.checked;
    if (a.alert) this.d.alertText = a.alert;
    if (a.setText) for (const [k, v] of Object.entries(a.setText)) this.d.context().elements[k].text = v;
    if (a.openWindow) this.d.openWindow(a.openWindow);
  }
  async clear() { this.s.value = ''; }
  async sendKeys(...k) { this.s.value = (this.s.value ?? '') + k.join(''); }
  async getText() { return this.s.text ?? ''; }
  async isSelected() { return !!this.s.checked; }
  async isDisplayed() { return this.s.visible !== false; }
  async findElements(by) {
    if (by.value === 'option') return (this.s.options ?? []).map((o) => new FakeElement(this.d, { ...o, optionOf: this.s }));
    const m = by.value.match(/normalize-space\(\.\)=['"](.*)['"]\]$/) ?? by.value.match(/option\[value="(.*)"\]/);
    const opt = (this.s.options ?? []).find((o) => o.label === m?.[1] || o.value === m?.[1]);
    return opt ? [new FakeElement(this.d, { ...opt, optionOf: this.s })] : [];
  }
  async findElement(by) {
    const [e] = await this.findElements(by);
    if (!e) throw new error.NoSuchElementError(`no ${by.value}`);
    return e;
  }
}

export class FakeDriver {
  constructor(site) {
    this.site = site;
    this.wins = [];
    this.cur = null;
    this.frameStack = [];
    this.alertText = null;
    this.log = [];
    this.quitCalled = false;
  }
  openWindow(path) { const w = { handle: `h${this.wins.length}`, url: new URL(path, this.base).href, page: this.site.pages[path] }; this.wins.push(w); return w; }
  context() { let c = this.cur.page; for (const f of this.frameStack) c = c.frames[f]; return c; }
  guardAlert() { if (this.alertText !== null) throw new error.UnexpectedAlertOpenError('alert open'); }
  async get(url) { this.guardAlert(); this.base = url; const p = new URL(url).pathname; if (!this.cur) this.cur = this.openWindow(p); else { this.cur.url = url; this.cur.page = this.site.pages[p]; } this.frameStack = []; }
  async findElements(by) {
    this.guardAlert();
    const ctx = this.context();
    const k = key(by);
    if (ctx.frames?.[k]) return [{ frameKey: k }];
    const s = ctx.elements?.[k];
    return s ? [new FakeElement(this, s)] : [];
  }
  async wait(condition, timeout) {
    const fn = typeof condition === 'function' ? condition : condition.fn;
    const end = Date.now() + Math.min(timeout, 300);
    for (;;) {
      const v = await fn(this);
      if (v) return v;
      if (Date.now() > end) throw new error.TimeoutError('wait timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  switchTo() {
    return {
      defaultContent: async () => { this.frameStack = []; },
      frame: async (el) => { this.frameStack.push(el.frameKey); },
      window: async (h) => { this.cur = this.wins.find((w) => w.handle === h); this.frameStack = []; },
      alert: async () => {
        if (this.alertText === null) throw new error.NoSuchAlertError('no alert');
        const d = this;
        return { getText: async () => d.alertText, accept: async () => { d.log.push('accept'); d.alertText = null; }, dismiss: async () => { d.log.push('dismiss'); d.alertText = null; }, sendKeys: async () => {} };
      },
    };
  }
  async executeScript(script, ...args) {
    this.guardAlert();
    if (script.includes('arguments[0].value')) return args[0].s.value ?? '';
    if (script.includes('getAttribute')) return args[0].s.attrs?.[args[1]] ?? null;
    if (script.includes(ENGINE_INFO)) return JSON.stringify({ ...this.site.engine, compatMode: 'BackCompat', hasActiveX: true, documentAllType: 'object', charset: 'shift_jis', url: this.cur.url, title: this.cur.page.title });
    if (script.includes(ERROR_DRAIN)) return '[]';
    if (script.includes(FORM_STATE)) return JSON.stringify([{ tag: 'input', name: args[0].s.id, value: args[0].s.value ?? '' }]);
    if (script.includes(DOM_SNAPSHOT)) return `<div>\n  #text "${args[0].s.text ?? ''}"`;
    throw new Error('unexpected script');
  }
  async takeScreenshot() { this.guardAlert(); return PNG_1PX; }
  async getCurrentUrl() { return this.cur.url; }
  async getTitle() { return this.cur.page.title; }
  async getWindowHandle() { return this.cur.handle; }
  async getAllWindowHandles() { return this.wins.map((w) => w.handle); }
  async close() { this.wins = this.wins.filter((w) => w !== this.cur); }
  async quit() { this.quitCalled = true; }
  manage() { return { window: () => ({ setRect: async () => {} }), setTimeouts: async () => {} }; }
  actions() { const d = this; return { sendKeys(k) { d.log.push(`keys ${k}`); return { perform: async () => {} }; } }; }
  async getCapabilities() { return new Map([['browserName', 'internet explorer'], ['browserVersion', '11']]); }
}
