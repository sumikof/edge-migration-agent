import type { Browser, BrowserContext, Dialog, FrameLocator, LaunchOptions, Locator as PwLocator, Page } from '@playwright/test';
import { Config, Scenario } from './core.js';
import {
  BrowserAdapter, DialogRecord, Diagnostics, HarnessError, Locator, RunFailure, RunResult, WindowInfo, envError, runScenario,
} from './runner.js';
import { resolveBaselineId } from './baseline.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ENV_ERROR = /net::ERR_(CONNECTION|NAME_NOT_RESOLVED|ADDRESS|INTERNET_DISCONNECTED|TIMED_OUT|CERT)|Executable doesn't exist|distribution '.*' is not found|Target page, context or browser has been closed|Browser closed/i;

function mapError(e: unknown): unknown {
  const message = (e as Error)?.message ?? String(e);
  if (e instanceof HarnessError) return e;
  if (ENV_ERROR.test(message)) return envError(message.split('\n')[0]);
  if ((e as Error)?.name === 'TimeoutError') return new HarnessError('timeout', message.split('\n')[0]);
  return e;
}
const fnFromSource = (src: string) => new Function('el', 'arg', `return (${src})(el, arg);`) as (el: unknown, arg: unknown) => string;

/** Playwright implementation of the common adapter (Chromium Edge, channel "msedge"). */
export class PlaywrightAdapter implements BrowserAdapter {
  private pages: Array<{ id: string; page: Page }> = [];
  private current!: Page;
  private seq = 0;
  private armed: { action: 'accept' | 'dismiss'; promptText?: string } | undefined;
  private handled: DialogRecord[] = [];
  private unexpected: DialogRecord[] = [];
  private diag: Diagnostics = { console: [], pageErrors: [], network: [], blockedRequests: [], scriptErrors: [], notes: [] };

  private constructor(private readonly browser: Browser, private readonly context: BrowserContext) {}

  static async launch(config: Config, scenario: Scenario, launchOverride?: LaunchOptions): Promise<PlaywrightAdapter> {
    const { chromium } = await import('@playwright/test');
    const options: LaunchOptions = launchOverride ?? {
      channel: config.edge.channel || undefined,
      headless: config.edge.headless,
    };
    const browser = await chromium.launch(options).catch((e) => { throw mapError(e); });
    const context = await browser.newContext({ viewport: config.viewport });
    const adapter = new PlaywrightAdapter(browser, context);
    if (config.safety.blockMutatingRequests && !scenario.allowMutatingRequests) {
      await context.route('**/*', (route) => {
        const req = route.request();
        if (MUTATING.has(req.method())) {
          adapter.diag.blockedRequests.push(`${req.method()} ${req.url()}`);
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });
    }
    context.on('page', (p) => adapter.track(p));
    adapter.current = await context.newPage();
    return adapter;
  }

  private track(page: Page): void {
    if (this.pages.some((p) => p.page === page)) return;
    this.pages.push({ id: `w${this.seq++}`, page });
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') this.diag.console.push(`[${m.type()}] ${m.text()}`.slice(0, 1000)); });
    page.on('pageerror', (err) => this.diag.pageErrors.push(`${err.name}: ${err.message}`.slice(0, 1000)));
    page.on('requestfailed', (req) => {
      const reason = req.failure()?.errorText ?? 'failed';
      if (reason !== 'net::ERR_BLOCKED_BY_CLIENT') this.diag.network.push(`${req.method()} ${req.url()} ${reason}`);
    });
    page.on('response', (res) => { if (res.status() >= 400) this.diag.network.push(`${res.request().method()} ${res.url()} HTTP ${res.status()}`); });
    page.on('dialog', (d) => this.onDialog(d));
    page.on('close', () => { this.pages = this.pages.filter((p) => p.page !== page); });
  }
  private onDialog(d: Dialog): void {
    const record: DialogRecord = { type: d.type(), message: d.message() };
    const spec = this.armed;
    this.armed = undefined;
    if (spec) {
      this.handled.push({ ...record, action: spec.action });
      void (spec.action === 'accept' ? d.accept(spec.promptText) : d.dismiss()).catch(() => {});
    } else {
      this.unexpected.push(record);
      void d.dismiss().catch(() => {});
    }
  }

  private locate(loc: Locator): PwLocator {
    let scope: Page | FrameLocator = this.current;
    for (const f of loc.frames) scope = scope.frameLocator(f);
    const sel = loc.xpath ? `xpath=${loc.xpath}` : loc.selector!;
    return scope.locator(sel).first();
  }
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) { throw mapError(e); }
  }

  navigate(url: string, timeoutMs: number) { return this.wrap(async () => { await this.current.goto(url, { waitUntil: 'load', timeout: timeoutMs }); }); }
  waitFor(loc: Locator, state: 'visible' | 'hidden', timeoutMs: number) { return this.wrap(() => this.locate(loc).waitFor({ state, timeout: timeoutMs })); }
  click(loc: Locator, timeoutMs: number) { return this.wrap(() => this.locate(loc).click({ timeout: timeoutMs })); }
  fill(loc: Locator, value: string, timeoutMs: number) { return this.wrap(() => this.locate(loc).fill(value, { timeout: timeoutMs })); }
  select(loc: Locator, choice: { value?: string; label?: string; index?: number }, timeoutMs: number) {
    const option = choice.value !== undefined ? { value: choice.value } : choice.label !== undefined ? { label: choice.label } : { index: choice.index! };
    return this.wrap(async () => { await this.locate(loc).selectOption(option, { timeout: timeoutMs }); });
  }
  setChecked(loc: Locator, checked: boolean, timeoutMs: number) { return this.wrap(() => this.locate(loc).setChecked(checked, { timeout: timeoutMs })); }
  press(loc: Locator | null, key: string, timeoutMs: number) {
    return this.wrap(() => loc ? this.locate(loc).press(key, { timeout: timeoutMs }) : this.current.keyboard.press(key));
  }
  text(loc: Locator, timeoutMs: number) { return this.wrap(() => this.locate(loc).innerText({ timeout: timeoutMs })); }
  value(loc: Locator, timeoutMs: number) { return this.wrap(() => this.locate(loc).inputValue({ timeout: timeoutMs })); }
  attribute(loc: Locator, name: string, timeoutMs: number) { return this.wrap(() => this.locate(loc).getAttribute(name, { timeout: timeoutMs })); }
  isChecked(loc: Locator, timeoutMs: number) { return this.wrap(() => this.locate(loc).isChecked({ timeout: timeoutMs })); }
  isVisible(loc: Locator) { return this.wrap(() => this.locate(loc).isVisible()); }
  evalElement(loc: Locator, fnSource: string, arg: unknown, timeoutMs: number) {
    return this.wrap(async () => {
      const l = this.locate(loc);
      await l.waitFor({ state: 'attached', timeout: timeoutMs });
      return String(await l.evaluate(fnFromSource(fnSource), arg));
    });
  }
  evalPage(fnSource: string, arg: unknown) {
    // The wrapper is built on the Node side and serialized by Playwright, so page CSP (unsafe-eval) does not apply.
    const fn = new Function('arg', `return (${fnSource})(null, arg);`) as (arg: unknown) => string;
    return this.wrap(async () => String(await this.current.evaluate(fn, arg)));
  }
  async url() { return this.current.url(); }
  screenshot(file: string, mask: Locator[]) {
    return this.wrap(async () => {
      await this.current.screenshot({ path: file, mask: mask.map((m) => this.locate(m)) });
      return { masked: true };
    });
  }
  async windows(): Promise<WindowInfo[]> {
    const out: WindowInfo[] = [];
    for (const { id, page } of this.pages) {
      if (page.isClosed()) continue;
      let title = '';
      try { title = await page.title(); } catch {}
      out.push({ id, url: page.url(), title, current: page === this.current });
    }
    return out;
  }
  async switchWindow(id: string) {
    const found = this.pages.find((p) => p.id === id);
    if (!found) throw new HarnessError('timeout', `Window ${id} is no longer open`);
    this.current = found.page;
    await this.wrap(() => found.page.waitForLoadState('load'));
    await found.page.bringToFront().catch(() => {});
  }
  async closeWindow() {
    const closing = this.current;
    await closing.close();
    const remaining = this.pages.filter((p) => p.page !== closing && !p.page.isClosed());
    if (!remaining.length) throw new HarnessError('script', 'The last window was closed');
    this.current = remaining[0].page;
  }
  armDialog(spec: { action: 'accept' | 'dismiss'; promptText?: string }) { this.armed = spec; }
  async handleDialog(_spec: { action: 'accept' | 'dismiss'; promptText?: string }, timeoutMs: number): Promise<DialogRecord> {
    const end = Date.now() + timeoutMs;
    while (!this.handled.length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    this.armed = undefined;
    const d = this.handled.shift();
    if (!d) throw new HarnessError('timeout', `No dialog appeared within ${timeoutMs} ms`);
    return d;
  }
  async takeUnexpectedDialogs() { const list = this.unexpected; this.unexpected = []; return list; }
  async afterStep() {}
  async drainDiagnostics() { const d = this.diag; this.diag = { console: [], pageErrors: [], network: [], blockedRequests: [], scriptErrors: [], notes: [] }; return d; }
  async browserVersion() { return `${this.browser.browserType().name()} ${this.browser.version()}`; }
  async close() { await this.browser.close(); }
}

export type EdgeRunOptions = {
  launchOverride?: LaunchOptions; baselineId?: string | null; mock?: boolean;
  adapterFactory?: () => Promise<BrowserAdapter>; diagnose?: () => Promise<unknown>;
};

export async function runEdge(config: Config, scenario: Scenario, options: EdgeRunOptions = {}): Promise<RunResult> {
  const { result } = await runScenario({
    target: 'edge', config, scenario, baseUrl: config.edgeBaseUrl,
    baselineId: options.baselineId !== undefined ? options.baselineId : resolveBaselineId(scenario.name),
    launch: async () => options.adapterFactory
      ? { adapter: await options.adapterFactory(), driver: 'mock' }
      : { adapter: await PlaywrightAdapter.launch(config, scenario, options.launchOverride), driver: `playwright channel=${options.launchOverride ? 'override' : config.edge.channel}` },
    diagnose: options.diagnose ?? (async () => (await import('./doctor.js')).diagnose(config, 'edge')),
    mock: options.mock ?? !!options.adapterFactory,
    environmentNotes: options.launchOverride ? ['Launched with a test override instead of channel "msedge".'] : [],
  });
  if (result.status !== 'passed') throw new RunFailure(result);
  return result;
}
