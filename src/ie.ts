import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Config, Scenario, artifactsRoot } from './core.js';
import {
  BrowserAdapter, DialogRecord, Diagnostics, HarnessError, Locator, RunFailure, RunResult, WindowInfo, envError, runScenario,
} from './runner.js';
import { ERROR_DRAIN } from './page-scripts.js';

const require = createRequire(import.meta.url);

function walkForIEDriver(dir: string, depth = 0): string | undefined {
  if (depth > 5 || !fs.existsSync(dir)) return undefined;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /^IEDriverServer\.exe$/i.test(entry.name)) return full;
    if (entry.isDirectory()) {
      const found = walkForIEDriver(full, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function locateIEDriver(): string | undefined {
  const explicit = process.env.IE_DRIVER_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`IE_DRIVER_PATH not found: ${explicit}`);
    return explicit;
  }
  return walkForIEDriver(path.join(process.cwd(), 'node_modules', 'iedriver'));
}

export function locateEdge(custom?: string): string | undefined {
  const choices = [custom, process.env.EDGE_PATH,
    `${process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)'}/Microsoft/Edge/Application/msedge.exe`,
    `${process.env.ProgramFiles || 'C:/Program Files'}/Microsoft/Edge/Application/msedge.exe`];
  return choices.find((item) => item && fs.existsSync(item));
}

/** Interactive desktop detection: services run in session 0 without SESSIONNAME. */
export function isInteractiveSession(): boolean | null {
  if (process.platform !== 'win32') return null;
  const name = process.env.SESSIONNAME;
  if (!name) return false;
  return !/^services$/i.test(name);
}

// IE mode must run serially (one IEDriver session per desktop). A pid lock file guards against parallel runs.
export function acquireIELock(): () => void {
  const dir = path.join(artifactsRoot(), '.locks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ie.lock');
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    let alive = false;
    try { if (pid) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
    if (alive && pid !== process.pid) throw envError(`Another IE-mode run is active (pid ${pid}). IE runs must be serial.`);
    fs.rmSync(file, { force: true });
  }
  fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  return () => { try { fs.rmSync(file, { force: true }); } catch {} };
}

const ENV_ERRORS = /SessionNotCreated|NoSuchSession|ECONNREFUSED|ECONNRESET|Unable to get browser|Protected Mode|zoom level|unable to connect|Could not start a new session|ERR_CONNECTION|could not be reached|Unable to find element on closed window/i;
function mapError(e: unknown): unknown {
  if (e instanceof HarnessError) return e;
  const name = (e as Error)?.name ?? '';
  const message = (e as Error)?.message ?? String(e);
  if (ENV_ERRORS.test(name) || ENV_ERRORS.test(message)) return envError(`${name}: ${message.split('\n')[0]}`);
  if (/Timeout/i.test(name)) return new HarnessError('timeout', message.split('\n')[0]);
  if (/UnexpectedAlertOpen/i.test(name)) return new HarnessError('unexpected-dialog', message.split('\n')[0]);
  return e;
}
const KEYS: Record<string, string> = {
  Enter: 'ENTER', Tab: 'TAB', Escape: 'ESCAPE', Backspace: 'BACK_SPACE', Delete: 'DELETE', Space: 'SPACE',
  ArrowUp: 'ARROW_UP', ArrowDown: 'ARROW_DOWN', ArrowLeft: 'ARROW_LEFT', ArrowRight: 'ARROW_RIGHT',
  Home: 'HOME', End: 'END', PageUp: 'PAGE_UP', PageDown: 'PAGE_DOWN', F1: 'F1', F5: 'F5',
};
function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s.split("'").map((p) => `'${p}'`).join(`, "'", `)})`;
}

/** Selenium + IEDriverServer implementation of the common adapter (Edge in IE mode). */
export class SeleniumIEAdapter implements BrowserAdapter {
  private scriptErrors: string[] = [];
  private notes: string[] = [];
  constructor(private readonly driver: any, private readonly webdriver: any) {}

  static async launch(config: Config): Promise<SeleniumIEAdapter> {
    if (process.platform !== 'win32') throw envError('IE mode requires native Windows.');
    if (isInteractiveSession() === false && process.env.IE_ALLOW_NONINTERACTIVE !== '1') {
      throw envError('IE mode needs an interactive desktop session (SESSIONNAME is missing or "Services"). Run from a logged-in console/RDP session.');
    }
    const driverPath = locateIEDriver();
    if (!driverPath) throw envError('IEDriverServer.exe not found. Install iedriver or set IE_DRIVER_PATH.');
    const edgePath = locateEdge(config.edgeExecutablePath);
    if (!edgePath) throw envError('msedge.exe not found. Set edgeExecutablePath in config/targets.json.');
    const webdriver = require('selenium-webdriver');
    const { Options, ServiceBuilder } = require('selenium-webdriver/ie');
    const opts = new Options();
    opts.setEdgeChromium(true);
    opts.setEdgePath(edgePath);
    opts.ensureCleanSession(config.ie.ensureCleanSession);
    opts.ignoreZoomSetting(config.ie.ignoreZoomSetting);
    opts.browserAttachTimeout(config.ie.attachTimeoutMs);
    // We answer dialogs explicitly; never let the driver silently dismiss them.
    opts.set('unhandledPromptBehavior', 'ignore');
    try {
      const driver = await new webdriver.Builder().forBrowser('ie').setIeOptions(opts)
        .setIeService(new ServiceBuilder(driverPath)).build();
      await driver.manage().window().setRect({ width: config.viewport.width, height: config.viewport.height });
      return new SeleniumIEAdapter(driver, webdriver);
    } catch (e) { throw mapError(e); }
  }

  private by(sel: string, xpath = false) {
    const { By } = this.webdriver;
    if (xpath) return By.xpath(sel);
    if (sel.startsWith('xpath=')) return By.xpath(sel.slice(6));
    return By.css(sel);
  }
  /** Re-resolves the frame chain from the top document every time (stale-safe for frame reloads). */
  private async locate(loc: Locator, timeoutMs: number): Promise<any> {
    const { until } = this.webdriver;
    await this.driver.switchTo().defaultContent();
    for (const f of loc.frames) {
      const el = await this.driver.wait(until.elementLocated(this.by(f)), timeoutMs, `frame ${f} not found`);
      await this.driver.switchTo().frame(el);
    }
    const by = loc.xpath ? this.by(loc.xpath, true) : this.by(loc.selector!);
    return this.driver.wait(until.elementLocated(by), timeoutMs, `element ${loc.xpath ?? loc.selector} not found`);
  }
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) { throw mapError(e); }
  }

  navigate(url: string, timeoutMs: number) {
    return this.wrap(async () => {
      await this.collectErrors();
      await this.driver.manage().setTimeouts({ pageLoad: timeoutMs });
      await this.driver.switchTo().defaultContent();
      await this.driver.get(url);
    });
  }
  waitFor(loc: Locator, state: 'visible' | 'hidden', timeoutMs: number) {
    return this.wrap(async () => {
      const { until } = this.webdriver;
      if (state === 'visible') {
        const el = await this.locate(loc, timeoutMs);
        await this.driver.wait(until.elementIsVisible(el), timeoutMs, `element not visible`);
        return;
      }
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (!(await this.isVisible(loc))) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new HarnessError('timeout', `element still visible after ${timeoutMs} ms`);
    });
  }
  click(loc: Locator, t: number) { return this.wrap(async () => { await (await this.locate(loc, t)).click(); }); }
  fill(loc: Locator, value: string, t: number) {
    return this.wrap(async () => { const e = await this.locate(loc, t); await e.clear(); await e.sendKeys(value); });
  }
  select(loc: Locator, choice: { value?: string; label?: string; index?: number }, t: number) {
    return this.wrap(async () => {
      const e = await this.locate(loc, t);
      const { By } = this.webdriver;
      let opt: any;
      if (choice.value !== undefined) opt = await e.findElement(By.css(`option[value=${JSON.stringify(choice.value)}]`));
      else if (choice.label !== undefined) opt = await e.findElement(By.xpath(`.//option[normalize-space(.)=${xpathLiteral(choice.label.trim())}]`));
      else {
        const all = await e.findElements(By.css('option'));
        opt = all[choice.index!];
        if (!opt) throw new HarnessError('assertion', `select has no option at index ${choice.index}`);
      }
      await opt.click();
    });
  }
  setChecked(loc: Locator, checked: boolean, t: number) {
    return this.wrap(async () => { const e = await this.locate(loc, t); if ((await e.isSelected()) !== checked) await e.click(); });
  }
  press(loc: Locator | null, key: string, t: number) {
    return this.wrap(async () => {
      const k = KEYS[key] ? this.webdriver.Key[KEYS[key]] : key;
      if (loc) await (await this.locate(loc, t)).sendKeys(k);
      else await this.driver.actions().sendKeys(k).perform();
    });
  }
  text(loc: Locator, t: number) { return this.wrap(async () => String(await (await this.locate(loc, t)).getText())); }
  value(loc: Locator, t: number) {
    return this.wrap(async () => String(await this.driver.executeScript('return arguments[0].value == null ? "" : String(arguments[0].value);', await this.locate(loc, t))));
  }
  attribute(loc: Locator, name: string, t: number) {
    return this.wrap(async () => {
      const v = await this.driver.executeScript('var v = arguments[0].getAttribute(arguments[1]); return v == null ? null : String(v);', await this.locate(loc, t), name);
      return v === null ? null : String(v);
    });
  }
  isChecked(loc: Locator, t: number) { return this.wrap(async () => Boolean(await (await this.locate(loc, t)).isSelected())); }
  isVisible(loc: Locator) {
    return this.wrap(async () => {
      try { return Boolean(await (await this.locate(loc, 500)).isDisplayed()); } catch { return false; }
    });
  }
  evalElement(loc: Locator, fnSource: string, arg: unknown, t: number) {
    return this.wrap(async () => String(await this.driver.executeScript(`return (${fnSource})(arguments[0], arguments[1]);`, await this.locate(loc, t), arg)));
  }
  evalPage(fnSource: string, arg: unknown) {
    return this.wrap(async () => {
      await this.driver.switchTo().defaultContent();
      return String(await this.driver.executeScript(`return (${fnSource})(null, arguments[0]);`, arg));
    });
  }
  url() { return this.wrap(async () => String(await this.driver.getCurrentUrl())); }
  screenshot(file: string, _mask: Locator[]) {
    return this.wrap(async () => {
      fs.writeFileSync(file, Buffer.from(await this.driver.takeScreenshot(), 'base64'));
      return { masked: false };
    });
  }
  windows() {
    return this.wrap(async () => {
      const current = await this.driver.getWindowHandle();
      const out: WindowInfo[] = [];
      for (const h of await this.driver.getAllWindowHandles()) {
        await this.driver.switchTo().window(h);
        out.push({ id: h, url: String(await this.driver.getCurrentUrl()), title: String(await this.driver.getTitle()), current: h === current });
      }
      await this.driver.switchTo().window(current);
      return out;
    });
  }
  switchWindow(id: string) { return this.wrap(async () => { await this.driver.switchTo().window(id); }); }
  closeWindow() {
    return this.wrap(async () => {
      await this.driver.close();
      const handles = await this.driver.getAllWindowHandles();
      if (!handles.length) throw new HarnessError('script', 'The last window was closed');
      await this.driver.switchTo().window(handles[0]);
    });
  }
  armDialog() { /* Selenium answers dialogs after they open. */ }
  handleDialog(spec: { action: 'accept' | 'dismiss'; promptText?: string }, timeoutMs: number) {
    return this.wrap(async (): Promise<DialogRecord> => {
      const { until } = this.webdriver;
      const alert = await this.driver.wait(until.alertIsPresent(), timeoutMs, 'No dialog appeared');
      const message = String(await alert.getText());
      if (spec.promptText !== undefined) await alert.sendKeys(spec.promptText);
      if (spec.action === 'accept') await alert.accept(); else await alert.dismiss();
      return { type: spec.promptText !== undefined ? 'prompt' : 'alert/confirm', message, action: spec.action };
    });
  }
  async takeUnexpectedDialogs(): Promise<DialogRecord[]> {
    try {
      const alert = await this.driver.switchTo().alert();
      const message = String(await alert.getText());
      await alert.dismiss();
      return [{ type: 'alert/confirm', message }];
    } catch { return []; }
  }
  /** IE has no console API over WebDriver; window.onerror is hooked per page instead (best effort). */
  private async collectErrors(): Promise<void> {
    try {
      await this.driver.switchTo().defaultContent();
      const raw = await this.driver.executeScript(`return (${ERROR_DRAIN})(null, null);`);
      this.scriptErrors.push(...(JSON.parse(String(raw)) as string[]));
    } catch { /* page without script access, e.g. about:blank */ }
  }
  afterStep() { return this.collectErrors(); }
  async drainDiagnostics(): Promise<Partial<Diagnostics>> {
    await this.collectErrors();
    this.notes.push('IE mode: console output and network failures are not observable through IEDriver; script errors are captured via window.onerror after each step.');
    return { scriptErrors: this.scriptErrors, notes: this.notes };
  }
  async browserVersion() {
    const caps = await this.driver.getCapabilities();
    return `IE mode (${caps.get('browserName')} ${caps.get('browserVersion') ?? ''})`.trim();
  }
  async close() { await this.driver.quit(); }
}

export type IERunOptions = { mock?: boolean; adapterFactory?: () => Promise<BrowserAdapter>; diagnose?: () => Promise<unknown> };

export async function runIE(config: Config, scenario: Scenario, options: IERunOptions = {}): Promise<RunResult> {
  const release = options.adapterFactory ? () => {} : acquireIELock();
  try {
    const { result } = await runScenario({
      target: 'ie', config, scenario, baseUrl: config.ieBaseUrl, baselineId: null,
      launch: async () => ({
        adapter: options.adapterFactory ? await options.adapterFactory() : await SeleniumIEAdapter.launch(config),
        driver: options.adapterFactory ? 'mock' : locateIEDriver(),
      }),
      diagnose: options.diagnose ?? (async () => (await import('./doctor.js')).diagnose(config, 'ie')),
      mock: options.mock ?? !!options.adapterFactory,
      interactive: isInteractiveSession(),
    });
    if (result.status !== 'passed') throw new RunFailure(result);
    return result;
  } finally { release(); }
}
