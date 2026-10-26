import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig, parseScenario, readJson, urlFor, resolveEnvValue, assertNotProduction, scenarioHash } from '../src/core.ts';
import { parseMigrationConfig, globToRegExp, matchesAny } from '../src/target.ts';
import { repoRoot, baseConfig } from './helpers/workspace.mjs';

test('starter config/targets.json stays valid and gets defaults', () => {
  const cfg = parseConfig(readJson(path.join(repoRoot, 'config/targets.json')));
  assert.equal(cfg.edge.channel, 'msedge');
  assert.equal(cfg.compare.visualGate, false, 'images are auxiliary by default');
  assert.equal(cfg.safety.blockMutatingRequests, true);
  assert.equal(cfg.retries.step, 0);
});

test('example configs are valid', () => {
  parseConfig(readJson(path.join(repoRoot, 'config/targets.example.json')));
  parseMigrationConfig(readJson(path.join(repoRoot, 'config/migration.example.json')));
  const mc = parseMigrationConfig(readJson(path.join(repoRoot, 'config/migration.json')));
  assert.equal(mc.targetApp.sourceRoot, '', 'shipped config must not point at any application');
  assert.equal(mc.fix.allowWrite, false, 'writes are disabled by default');
});

test('config schema reports precise errors', () => {
  assert.throws(() => parseConfig({ ...baseConfig, timeoutMs: 'x' }), /\$\.timeoutMs: expected integer/);
  assert.throws(() => parseConfig({ ...baseConfig, ieBaseUrl: 'ftp://x' }), /ieBaseUrl: must match/);
  assert.throws(() => parseConfig({ ...baseConfig, typo: 1 }), /\$\.typo: unknown property/);
  assert.throws(() => parseConfig({ ...baseConfig, masking: { redact: [{ name: 'bad', regex: '(' }] } }), /masking rule bad/);
  assert.throws(() => parseMigrationConfig({ targetApp: { sourceRoot: '' }, fix: { maxTotalAttempts: 0 } }), /must be >= 1/);
});

test('all shipped scenarios (and examples) validate; starter step format is accepted', () => {
  for (const dir of ['scenarios', 'scenarios/examples']) {
    for (const f of fs.readdirSync(path.join(repoRoot, dir)).filter((x) => x.endsWith('.json'))) {
      parseScenario(readJson(path.join(repoRoot, dir, f)), f);
    }
  }
  const legacy = parseScenario({ name: 'legacy', steps: [
    { op: 'navigate', path: '/' }, { op: 'waitVisible', selector: 'body', frame: 'iframe#main' },
    { op: 'fill', selector: '#q', value: 'x' }, { op: 'select', selector: '#s', value: '1' },
    { op: 'assertTextContains', selector: 'h1', text: 'x' }, { op: 'captureText', selector: 'h1', key: 'k', optional: true },
    { op: 'click', selector: '#b' }, { op: 'screenshot', name: 'home' },
  ] });
  assert.equal(legacy.steps.length, 8);
});

test('scenario validation rejects unsupported or incomplete steps', () => {
  assert.throws(() => parseScenario({ name: 's', steps: [{ op: 'eval', selector: 'x' }] }), /must be one of/);
  assert.throws(() => parseScenario({ name: 's', steps: [{ op: 'click' }] }), /requires "selector" or "xpath"/);
  assert.throws(() => parseScenario({ name: 's', steps: [{ op: 'navigate' }] }), /requires "path"/);
  assert.throws(() => parseScenario({ name: 's', steps: [{ op: 'click', selector: 'a', xpath: '//a' }] }), /both selector and xpath/);
  assert.throws(() => parseScenario({ name: '../x', steps: [] }), /must match/);
  assert.throws(() => parseScenario({ name: 's', steps: [{ op: 'wait', ms: 60000 }] }), /<= 10000/);
});

test('navigation stays on the configured origin', () => {
  assert.equal(urlFor('http://a.local/app/', 'x.jsp'), 'http://a.local/app/x.jsp');
  assert.throws(() => urlFor('http://a.local', 'https://evil.example'), /relative path/);
  assert.throws(() => urlFor('http://a.local', '//evil.example/x'), /relative path/);
});

test('credentials come from environment variables and are registered as secrets', () => {
  process.env.TEST_PW = 'hunter2!';
  const secrets = new Set();
  assert.equal(resolveEnvValue('${env:TEST_PW}', secrets), 'hunter2!');
  assert.ok(secrets.has('hunter2!'));
  assert.throws(() => resolveEnvValue('${env:NOT_SET_ANYWHERE_123}', secrets), /not set/);
});

test('production URL patterns block runs', () => {
  const cfg = parseConfig({ ...baseConfig, ieBaseUrl: 'https://prod.example.jp', safety: { productionUrlPatterns: ['://prod\\.'] } });
  assert.throws(() => assertNotProduction(cfg), /Refusing to run/);
});

test('scenario hash changes when steps change', () => {
  const a = { name: 's', steps: [{ op: 'navigate', path: '/' }] };
  const b = { name: 's', steps: [{ op: 'navigate', path: '/x' }] };
  assert.notEqual(scenarioHash(a), scenarioHash(b));
  assert.equal(scenarioHash(a), scenarioHash(JSON.parse(JSON.stringify(a))));
});

test('glob matching', () => {
  assert.ok(globToRegExp('**/*.js').test('a/b/c.js'));
  assert.ok(globToRegExp('**/*.js').test('c.js'));
  assert.ok(!globToRegExp('web/*.js').test('web/a/b.js'));
  assert.ok(matchesAny('web/x.jsp', ['**/*.{jsp,html}']));
  assert.ok(matchesAny('.git/__dir__', ['**/.git/**']));
});
