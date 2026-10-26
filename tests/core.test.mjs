import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import url from 'node:url';
import path from 'node:path';

// These tests inspect definitions without requiring browser binaries.
const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
test('sample scenario has non-destructive operations', () => {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'scenarios/sample.json'), 'utf8'));
  assert.ok(data.steps.some((s) => s.op === 'screenshot'));
  assert.ok(data.steps.every((s) => ['navigate','waitVisible','captureText','screenshot'].includes(s.op)));
});
test('targets must not contain credentials', () => {
  const txt = fs.readFileSync(path.join(root, 'config/targets.json'), 'utf8');
  assert.equal(/password|secret|apiKey/i.test(txt), false);
});
