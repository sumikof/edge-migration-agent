import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Config, Scenario, Step, outputDir, saveJson, urlFor } from './core.js';

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

export async function runIE(config: Config, scenario: Scenario): Promise<void> {
  if (process.platform !== 'win32') throw new Error('IE mode requires native Windows.');
  const driverPath = locateIEDriver();
  if (!driverPath) throw new Error('IEDriverServer.exe not found. Install iedriver or set IE_DRIVER_PATH.');
  const edgePath = locateEdge(config.edgeExecutablePath);
  if (!edgePath) throw new Error('msedge.exe not found. Set edgeExecutablePath in config/targets.json.');
  const { Builder, By, until } = require('selenium-webdriver');
  const { Options, ServiceBuilder } = require('selenium-webdriver/ie');
  const opts = new Options();
  opts.setEdgeChromium(true);
  opts.setEdgePath(edgePath);
  const driver = await new Builder().forBrowser('ie').setIeOptions(opts)
    .setIeService(new ServiceBuilder(driverPath)).build();
  const dir = outputDir('ie', scenario.name);
  const captures: Record<string, string> = {};
  const results: Array<{ index: number; op: string; status: string; error?: string }> = [];
  let error: Error | undefined;
  try {
    await driver.manage().window().setRect({ width: config.viewport.width, height: config.viewport.height });
    for (const [index, step] of scenario.steps.entries()) {
      try {
        await runStep(step, index);
        results.push({ index, op: step.op, status: 'passed' });
      } catch (e) {
        if (step.optional) {
          results.push({ index, op: step.op, status: 'skipped', error: String(e) });
        } else {
          results.push({ index, op: step.op, status: 'failed', error: String(e) });
          throw e;
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    try { fs.writeFileSync(path.join(dir, 'failure.png'), Buffer.from(await driver.takeScreenshot(), 'base64')); } catch {}
  } finally {
    saveJson(path.join(dir, 'result.json'), { scenario: scenario.name, target: 'ie', passed: !error, captures, results });
    try { await driver.quit(); } catch {}
  }
  if (error) throw error;

  async function element(step: Step): Promise<any> {
    await driver.switchTo().defaultContent();
    if (step.frame) {
      const f = await driver.wait(until.elementLocated(By.css(step.frame)), config.timeoutMs);
      await driver.switchTo().frame(f);
    }
    return driver.wait(until.elementLocated(By.css(step.selector)), config.timeoutMs);
  }
  async function runStep(step: Step, index: number): Promise<void> {
    if (step.op === 'navigate') {
      await driver.get(urlFor(config.ieBaseUrl, step.path!));
      return;
    }
    if (step.op === 'screenshot') {
      const name = step.name ?? `step-${index}`;
      if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid screenshot name: ${name}`);
      fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(await driver.takeScreenshot(), 'base64'));
      return;
    }
    const e = await element(step);
    if (step.op === 'waitVisible') { await driver.wait(until.elementIsVisible(e), config.timeoutMs); return; }
    if (step.op === 'click') { await e.click(); return; }
    if (step.op === 'fill') { await e.clear(); await e.sendKeys(step.value ?? ''); return; }
    if (step.op === 'select') {
      const value = step.value ?? '';
      // Native <select> supports setting the value via the option's click.
      const opt = await e.findElement(By.css(`option[value=${JSON.stringify(value)}]`));
      await opt.click();
      return;
    }
    if (step.op === 'assertTextContains') {
      const actual = await e.getText();
      if (!actual.includes(step.text ?? '')) throw new Error(`Text mismatch at step ${index}: expected ${JSON.stringify(step.text)}, actual ${JSON.stringify(actual.slice(0, 300))}`);
      return;
    }
    if (step.op === 'captureText') { captures[step.key ?? `step-${index}`] = await e.getText(); return; }
    throw new Error(`Unknown step: ${step.op}`);
  }
}
