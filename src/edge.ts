import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { Config, Scenario, Step, outputDir, saveJson, urlFor } from './core.js';

export async function runEdge(config: Config, scenario: Scenario): Promise<void> {
  const browser = await chromium.launch({ channel: 'msedge', headless: false });
  const context = await browser.newContext({ viewport: config.viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);
  const dir = outputDir('edge', scenario.name);
  const captures: Record<string, string> = {};
  const results: Array<{ index: number; op: string; status: string; error?: string }> = [];
  let error: Error | undefined;
  try {
    for (const [index, step] of scenario.steps.entries()) {
      try {
        await runStep(page, step, index);
        results.push({ index, op: step.op, status: 'passed' });
      } catch (e) {
        if (step.optional) results.push({ index, op: step.op, status: 'skipped', error: String(e) });
        else { results.push({ index, op: step.op, status: 'failed', error: String(e) }); throw e; }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    try { await page.screenshot({ path: path.join(dir, 'failure.png') }); } catch {}
  } finally {
    saveJson(path.join(dir, 'result.json'), { scenario: scenario.name, target: 'edge', passed: !error, captures, results });
    await browser.close();
  }
  if (error) throw error;

  async function runStep(page: Page, step: Step, index: number): Promise<void> {
    if (step.op === 'navigate') { await page.goto(urlFor(config.edgeBaseUrl, step.path!), { waitUntil: 'domcontentloaded' }); return; }
    if (step.op === 'screenshot') {
      const name = step.name ?? `step-${index}`;
      if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid screenshot name: ${name}`);
      await page.screenshot({ path: path.join(dir, `${name}.png`) }); return;
    }
    const loc = step.frame ? page.frameLocator(step.frame).locator(step.selector!) : page.locator(step.selector!);
    if (step.op === 'waitVisible') { await loc.waitFor({ state: 'visible' }); return; }
    if (step.op === 'click') { await loc.click(); return; }
    if (step.op === 'fill') { await loc.fill(step.value ?? ''); return; }
    if (step.op === 'select') { await loc.selectOption(step.value ?? ''); return; }
    if (step.op === 'assertTextContains') {
      const actual = (await loc.innerText());
      if (!actual.includes(step.text ?? '')) throw new Error(`Text mismatch at step ${index}: expected ${JSON.stringify(step.text)}, actual ${JSON.stringify(actual.slice(0, 300))}`);
      return;
    }
    if (step.op === 'captureText') { captures[step.key ?? `step-${index}`] = await loc.innerText(); return; }
    throw new Error(`Unknown step: ${step.op}`);
  }
}
