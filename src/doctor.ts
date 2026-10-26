import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Config, artifactsRoot, listScenarios, resolveScenario, root } from './core.js';
import { isInteractiveSession, locateEdge, locateIEDriver } from './ie.js';
import { getMigrationConfig, resolveTargetRoot, TargetNotConfigured } from './target.js';
import { readLock, verifyBaseline } from './baseline.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export type Check = { id: string; status: CheckStatus; detail: string; scope: 'ie' | 'edge' | 'common' };
export type DoctorReport = { createdAt: string; platform: string; checks: Check[]; ok: boolean };

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0, out: `${stdout}${stderr}`.trim() });
    });
  });
}
async function regQuery(key: string, value: string): Promise<string | undefined> {
  const r = await run('reg', ['query', key, '/v', value]);
  if (r.code !== 0) return undefined;
  return r.out.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.*)`, 'i'))?.[1]?.trim();
}
async function probeUrl(url: string, timeoutMs = 5000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // GET without credentials; only the status line is reported.
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    return `HTTP ${res.status}`;
  } finally { clearTimeout(t); }
}

export async function diagnose(config: Config | undefined, scope: 'ie' | 'edge' | 'all' = 'all'): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, detail: string, s: Check['scope'] = 'common') => checks.push({ id, status, detail, scope: s });
  const wantIE = scope !== 'edge', wantEdge = scope !== 'ie';
  const win = process.platform === 'win32';

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22 ? 'ok' : 'fail', `Node ${process.version} (>= 22 required)`);
  add('platform', win ? 'ok' : wantIE ? 'warn' : 'ok', `${os.platform()} ${os.release()}${win ? '' : ' - IE mode can only run on native Windows (not WSL/Docker).'}`);

  if (wantIE) {
    const interactive = isInteractiveSession();
    add('ie.interactive-session', interactive === null ? 'skip' : interactive ? 'ok' : 'fail',
      interactive === null ? 'not Windows' : interactive ? `SESSIONNAME=${process.env.SESSIONNAME}` : 'No interactive desktop (service/session 0). IEDriver needs a logged-in desktop.', 'ie');
    const edge = config ? locateEdge(config.edgeExecutablePath) : undefined;
    add('ie.msedge', edge ? 'ok' : win ? 'fail' : 'skip', edge ?? 'msedge.exe NOT FOUND (set edgeExecutablePath or EDGE_PATH)', 'ie');
    let driver: string | undefined;
    try { driver = locateIEDriver(); } catch (e) { add('ie.driver', 'fail', String((e as Error).message), 'ie'); }
    if (!checks.some((c) => c.id === 'ie.driver')) add('ie.driver', driver ? 'ok' : win ? 'fail' : 'warn', driver ?? 'IEDriverServer.exe NOT FOUND (npm install iedriver or set IE_DRIVER_PATH)', 'ie');
    if (driver && win) {
      const v = await run(driver, ['--version']);
      add('ie.driver-version', v.code === 0 ? 'ok' : 'warn', v.out.split('\n')[0] || 'unknown', 'ie');
    }
    if (win) {
      const zones: string[] = [];
      for (const z of [1, 2, 3, 4]) {
        const v = await regQuery(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Zones\\${z}`, '2500');
        zones.push(v ?? '?');
      }
      const uniform = zones.every((z) => z === zones[0]);
      add('ie.protected-mode', uniform ? 'ok' : 'fail', `Protected Mode (2500) per zone 1-4: ${zones.join(', ')} - must be identical in every zone (ask an administrator; do not bypass corporate policy).`, 'ie');
      const zoom = await regQuery('HKCU\\Software\\Microsoft\\Internet Explorer\\Zoom', 'ZoomFactor');
      add('ie.zoom', !zoom || /0x186a0/i.test(zoom) ? 'ok' : 'warn', `ZoomFactor=${zoom ?? 'default'} (100% = 0x186a0)`, 'ie');
      const level = (await regQuery('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'InternetExplorerIntegrationLevel'))
        ?? (await regQuery('HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge', 'InternetExplorerIntegrationLevel'));
      add('ie.edge-policy', level ? 'ok' : 'warn', level ? `InternetExplorerIntegrationLevel=${level}` : 'No InternetExplorerIntegrationLevel policy found; IE mode may be disabled by policy.', 'ie');
      const siteList = (await regQuery('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'InternetExplorerIntegrationSiteList'))
        ?? (await regQuery('HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge', 'InternetExplorerIntegrationSiteList'));
      add('ie.site-list', siteList ? 'ok' : 'warn', siteList ? `Site list: ${siteList}` : 'No Enterprise Mode site list policy; IEDriver forces IE mode for the session, but verify documentMode matches production.', 'ie');
    }
    const lock = path.join(artifactsRoot(), '.locks', 'ie.lock');
    add('ie.serial-lock', fs.existsSync(lock) ? 'warn' : 'ok', fs.existsSync(lock) ? `Lock file present (pid ${fs.readFileSync(lock, 'utf8').trim()}); remove only if no IE run is active.` : 'no IE run active', 'ie');
  }
  if (wantEdge) {
    const candidates = win ? [locateEdge()] : ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge'].filter((p) => fs.existsSync(p));
    const found = candidates.find(Boolean);
    add('edge.msedge-channel', found ? 'ok' : 'warn', found ? `Microsoft Edge found: ${found}` : 'Microsoft Edge not found for Playwright channel "msedge".', 'edge');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8'));
      add('edge.playwright', 'ok', `@playwright/test ${pkg.version}`, 'edge');
    } catch { add('edge.playwright', 'fail', '@playwright/test not installed (npm ci)', 'edge'); }
  }

  if (config) {
    add('config.targets', 'ok', `config/targets.json valid; IE ${config.ieBaseUrl}; Edge ${config.edgeBaseUrl}`);
    for (const [name, url] of [['ie', config.ieBaseUrl], ['edge', config.edgeBaseUrl]] as const) {
      if ((name === 'ie' && !wantIE) || (name === 'edge' && !wantEdge)) continue;
      try { add(`${name}.url`, 'ok', `${url} -> ${await probeUrl(url)}`, name); }
      catch (e) { add(`${name}.url`, 'fail', `${url} unreachable: ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message}`, name); }
    }
  } else add('config.targets', 'fail', 'config/targets.json is invalid');
  for (const s of listScenarios()) {
    try {
      resolveScenario(s);
      const lock = readLock(s);
      const integrity = lock ? verifyBaseline(lock) : [];
      add(`scenario.${s}`, integrity.length ? 'fail' : 'ok', lock ? `valid; baseline ${lock.runId}${integrity.length ? ` TAMPERED: ${integrity.join(', ')}` : ' intact'}` : 'valid; no locked baseline');
    } catch (e) { add(`scenario.${s}`, 'fail', (e as Error).message); }
  }
  try {
    const mc = getMigrationConfig();
    try {
      const t = resolveTargetRoot(mc);
      add('target.sourceRoot', 'ok', `${t}; fix.allowWrite=${mc.fix.allowWrite}`);
      const git = await run('git', ['-C', t, 'rev-parse', '--is-inside-work-tree']);
      add('target.git', git.code === 0 ? 'ok' : mc.fix.requireGit ? 'warn' : 'skip', git.code === 0 ? 'git work tree' : 'not a git repository (fixes require git when fix.requireGit is true)');
    } catch (e) {
      add('target.sourceRoot', e instanceof TargetNotConfigured ? 'skip' : 'fail', (e as Error).message);
    }
  } catch (e) { add('config.migration', 'fail', (e as Error).message); }
  try {
    fs.mkdirSync(artifactsRoot(), { recursive: true });
    fs.accessSync(artifactsRoot(), fs.constants.W_OK);
    add('artifacts.writable', 'ok', artifactsRoot());
  } catch (e) { add('artifacts.writable', 'fail', String(e)); }

  return { createdAt: new Date().toISOString(), platform: process.platform, checks, ok: !checks.some((c) => c.status === 'fail') };
}

export function formatDoctor(r: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' };
  return [...r.checks.map((c) => `[${icon[c.status]}] ${c.id.padEnd(26)} ${c.detail}`),
    '', 'Note: Availability is not proof of successful IE-mode automation. Run "npm run baseline:ie" with the smoke scenario to validate driver boot and navigation.'].join('\n');
}
