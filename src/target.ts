import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, root } from './core.js';
import { assertValid } from './schema.js';
import { migrationSchema } from './schemas.js';

// The business application lives OUTSIDE this harness. Everything that reads or
// writes it goes through resolveTargetRoot(), which refuses unset or unsafe paths.

export type Encoding = 'utf-8' | 'shift_jis' | 'cp932' | 'euc-jp';
export type MigrationConfig = {
  targetApp: {
    sourceRoot: string; include: string[]; exclude: string[]; defaultEncoding: 'auto' | Encoding;
    encodingOverrides: Record<string, Encoding>; maxFileBytes: number;
  };
  fix: {
    allowWrite: boolean; writableGlobs: string[]; maxAttemptsPerFinding: number; maxTotalAttempts: number;
    maxEditsPerAttempt: number; requireGit: boolean; requireCleanFiles: boolean; verifyScenarios: string[];
  };
};

export const DEFAULT_INCLUDE = ['**/*.js', '**/*.jsp', '**/*.jspf', '**/*.tag', '**/*.inc', '**/*.html', '**/*.htm', '**/*.css', '**/*.htc', '**/*.vbs', '**/*.asp'];
export const DEFAULT_EXCLUDE = ['**/.git/**', '**/node_modules/**', '**/*.min.js', '**/*.min.css', '**/WEB-INF/classes/**', '**/target/**', '**/build/**'];

export class TargetNotConfigured extends Error {
  constructor() {
    super('No target application is configured. Set targetApp.sourceRoot in config/migration.json (or MIGRATION_TARGET_DIR) to the absolute path of the business application source. Analysis and fixes are disabled until then.');
    this.name = 'TargetNotConfigured';
  }
}

export function migrationConfigPath(): string {
  return process.env.MIGRATION_CONFIG ? path.resolve(process.env.MIGRATION_CONFIG) : path.join(root, 'config', 'migration.json');
}
export function parseMigrationConfig(data: unknown, file = 'config/migration.json'): MigrationConfig {
  const raw = assertValid<{ targetApp: Partial<MigrationConfig['targetApp']>; fix: Partial<MigrationConfig['fix']> }>(migrationSchema, data, file);
  return {
    targetApp: {
      sourceRoot: raw.targetApp.sourceRoot ?? '',
      include: raw.targetApp.include ?? DEFAULT_INCLUDE,
      exclude: raw.targetApp.exclude ?? DEFAULT_EXCLUDE,
      defaultEncoding: raw.targetApp.defaultEncoding ?? 'auto',
      encodingOverrides: raw.targetApp.encodingOverrides ?? {},
      maxFileBytes: raw.targetApp.maxFileBytes ?? 5 * 1024 * 1024,
    },
    fix: {
      allowWrite: raw.fix.allowWrite ?? false,
      writableGlobs: raw.fix.writableGlobs ?? [],
      maxAttemptsPerFinding: raw.fix.maxAttemptsPerFinding ?? 3,
      maxTotalAttempts: raw.fix.maxTotalAttempts ?? 15,
      maxEditsPerAttempt: raw.fix.maxEditsPerAttempt ?? 10,
      requireGit: raw.fix.requireGit ?? true,
      requireCleanFiles: raw.fix.requireCleanFiles ?? true,
      verifyScenarios: raw.fix.verifyScenarios ?? [],
    },
  };
}
export function getMigrationConfig(file = migrationConfigPath()): MigrationConfig {
  if (!fs.existsSync(file)) return parseMigrationConfig({ targetApp: { sourceRoot: '' }, fix: {} }, file);
  return parseMigrationConfig(readJson(file), file);
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Directories that can never be a target themselves. */
function forbiddenExact(): string[] {
  return [os.homedir(), path.parse(process.cwd()).root, '/opt', '/var', '/srv', '/tmp', os.tmpdir()].map((p) => path.resolve(p));
}
/** Directory trees that can never contain a target. */
function forbiddenTrees(): string[] {
  const list = process.platform === 'win32'
    ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.ProgramData || 'C:\\ProgramData']
    : ['/usr', '/etc', '/bin', '/sbin', '/boot', '/proc', '/sys', '/System', '/Library'];
  return list.map((p) => path.resolve(p));
}

/** Validates and returns the real path of the external target directory. */
export function resolveTargetRoot(mc: MigrationConfig, harnessRoot = root): string {
  const configured = (process.env.MIGRATION_TARGET_DIR ?? mc.targetApp.sourceRoot).trim();
  if (!configured) throw new TargetNotConfigured();
  if (!path.isAbsolute(configured)) throw new Error(`targetApp.sourceRoot must be an absolute path: ${configured}`);
  if (!fs.existsSync(configured) || !fs.statSync(configured).isDirectory()) throw new Error(`Target directory does not exist: ${configured}`);
  const real = fs.realpathSync.native(configured);
  const harness = fs.realpathSync.native(harnessRoot);
  if (isWithin(real, harness)) throw new Error(`Target ${real} is inside the migration harness. The business application must live outside this repository.`);
  if (isWithin(harness, real)) throw new Error(`Target ${real} contains the migration harness itself. Point sourceRoot at the application directory only.`);
  for (const f of forbiddenExact()) {
    if (norm(real) === norm(f)) throw new Error(`Refusing to use ${real} as a target: it is a system, temp or home directory, not an application directory.`);
  }
  for (const f of forbiddenTrees()) {
    if (isWithin(real, f)) throw new Error(`Refusing to use ${real} as a target: it is under the system directory ${f}.`);
  }
  return real;
}

/** Glob -> RegExp supporting **, *, ?, {a,b}. Paths are matched with forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}
export function matchesAny(rel: string, globs: string[]): boolean {
  const p = rel.split(path.sep).join('/');
  return globs.some((g) => globToRegExp(g).test(p));
}

/** Lists files under the target root that match include/exclude. Symlinks are not followed. */
export function listTargetFiles(mc: MigrationConfig, targetRoot: string, scope?: string[]): string[] {
  const out: string[] = [];
  const include = scope?.length ? scope : mc.targetApp.include;
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(targetRoot, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (matchesAny(`${r}/__dir__`, mc.targetApp.exclude)) continue;
        walk(r);
      } else if (e.isFile() && matchesAny(r, include) && !matchesAny(r, mc.targetApp.exclude)) {
        if (fs.statSync(path.join(targetRoot, r)).size <= mc.targetApp.maxFileBytes) out.push(r);
      }
    }
  };
  walk('');
  return out.sort();
}

/** Resolves a target-relative path and guarantees it stays inside the target root. */
export function targetPath(targetRoot: string, rel: string): string {
  if (path.isAbsolute(rel)) {
    if (!isWithin(path.resolve(rel), targetRoot)) throw new Error(`${rel} is outside the target directory ${targetRoot}`);
    rel = path.relative(targetRoot, rel);
  }
  const full = path.resolve(targetRoot, rel);
  if (!isWithin(full, targetRoot)) throw new Error(`${rel} escapes the target directory`);
  if (fs.existsSync(full) && !isWithin(fs.realpathSync.native(full), targetRoot)) throw new Error(`${rel} resolves outside the target directory (symlink)`);
  return full;
}
export function toRel(targetRoot: string, full: string): string {
  return path.relative(targetRoot, full).split(path.sep).join('/');
}
