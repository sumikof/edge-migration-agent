import fs from 'node:fs';
import path from 'node:path';

export type Target = 'ie' | 'edge';
export type Step = {
  op: 'navigate' | 'waitVisible' | 'click' | 'fill' | 'select' | 'assertTextContains' | 'captureText' | 'screenshot';
  path?: string;
  selector?: string;
  frame?: string;
  value?: string;
  text?: string;
  key?: string;
  name?: string;
  optional?: boolean;
};
export type Scenario = { name: string; description?: string; steps: Step[] };
export type Config = {
  ieBaseUrl: string; edgeBaseUrl: string; edgeExecutablePath: string;
  viewport: { width: number; height: number }; timeoutMs: number;
  visualDiffThreshold: number; maxDiffRatio: number;
};

export const root = process.cwd();
export function safeName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error(`Unsafe name: ${value}. Use letters, digits, _ or - only.`);
  }
  return value;
}
export function resolveScenario(name: string): Scenario {
  const file = path.join(root, 'scenarios', safeName(name) + '.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario;
  if (data.name !== name || !Array.isArray(data.steps)) throw new Error(`Invalid scenario ${file}`);
  for (const [i, s] of data.steps.entries()) {
    if (!['navigate','waitVisible','click','fill','select','assertTextContains','captureText','screenshot'].includes(s.op)) {
      throw new Error(`Unsupported operation at step ${i}: ${s.op}`);
    }
  }
  return data;
}
export function getConfig(): Config {
  return JSON.parse(fs.readFileSync(path.join(root, 'config/targets.json'), 'utf8')) as Config;
}
export function outputDir(target: Target, name: string): string {
  const dir = path.join(root, 'artifacts', target, safeName(name));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function urlFor(base: string, pagePath: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(pagePath) || pagePath.startsWith('//')) {
    throw new Error('Navigation must be a relative path, not an external URL');
  }
  const origin = new URL(base);
  const resolved = new URL(pagePath, origin);
  if (resolved.origin !== origin.origin) throw new Error('Navigation escaped the configured origin');
  return resolved.href;
}
export function saveJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
export function hasFile(file: string): boolean { return fs.existsSync(file); }
