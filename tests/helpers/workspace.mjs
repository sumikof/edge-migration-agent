// Temporary workspace: artifacts, scenarios and an external "business application"
// directory, all outside the harness repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

export const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');

export function makeWorkspace(prefix = 'ema-') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const ws = {
    base,
    artifacts: path.join(base, 'artifacts'),
    scenarios: path.join(base, 'scenarios'),
    app: path.join(base, 'legacy-app'),
    migrationConfig: path.join(base, 'migration.json'),
  };
  fs.mkdirSync(ws.artifacts, { recursive: true });
  fs.mkdirSync(ws.scenarios, { recursive: true });
  process.env.ARTIFACTS_DIR = ws.artifacts;
  process.env.SCENARIOS_DIR = ws.scenarios;
  process.env.MIGRATION_CONFIG = ws.migrationConfig;
  delete process.env.MIGRATION_TARGET_DIR;
  return ws;
}
export function writeScenario(ws, scenario) {
  fs.writeFileSync(path.join(ws.scenarios, `${scenario.name}.json`), JSON.stringify(scenario, null, 2));
}
export function writeMigrationConfig(ws, overrides = {}) {
  const cfg = {
    targetApp: { sourceRoot: ws.app, ...(overrides.targetApp ?? {}) },
    fix: { allowWrite: true, writableGlobs: ['**/*.js', '**/*.jsp', '**/*.html'], requireGit: true, ...(overrides.fix ?? {}) },
  };
  fs.writeFileSync(ws.migrationConfig, JSON.stringify(cfg, null, 2));
  return cfg;
}
export function copyFixtureApp(ws) {
  fs.cpSync(path.join(repoRoot, 'tests', 'fixtures', 'legacy-app'), ws.app, { recursive: true });
}
export function gitInit(dir) {
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'test');
  run('config', 'core.autocrlf', 'false');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return run;
}
export function cleanup(ws) {
  // Baseline files are made read-only; restore permissions before removal.
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); try { fs.chmodSync(p, 0o755); } catch {} if (e.isDirectory()) walk(p); } };
  try { walk(ws.base); } catch {}
  fs.rmSync(ws.base, { recursive: true, force: true });
}
export const baseConfig = {
  ieBaseUrl: 'http://ie.test.local', edgeBaseUrl: 'http://edge.test.local', edgeExecutablePath: '',
  viewport: { width: 800, height: 600 }, timeoutMs: 500, visualDiffThreshold: 0.1, maxDiffRatio: 0.01,
};
