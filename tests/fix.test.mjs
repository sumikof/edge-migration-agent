import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import { parseConfig, scenarioHash } from '../src/core.ts';
import { runIE } from '../src/ie.ts';
import { runEdge } from '../src/edge.ts';
import { lockBaseline } from '../src/baseline.ts';
import { analyzeTarget, writeAnalysis } from '../src/analyzer.ts';
import { beginAttempt, applyEdits, verifyAttempt, testAttempt, restoreAttempt, fixStatus, FixRefused } from '../src/fix.ts';
import { getMigrationConfig } from '../src/target.ts';
import { decide } from '../src/hooks/edit-guard.ts';
import { MockAdapter, orderSite, ORDER_SCENARIO, IE_ENGINE, EDGE_ENGINE } from './helpers/mock-browser.mjs';
import { makeWorkspace, cleanup, baseConfig, writeScenario, writeMigrationConfig, copyFixtureApp, gitInit, repoRoot } from './helpers/workspace.mjs';

const ws = makeWorkspace();
after(() => cleanup(ws));
copyFixtureApp(ws);
const SJIS = '<%@ page pageEncoding="Windows-31J" %>\r\n<script>\r\nfunction 選択() {\r\n  var r = window.showModalDialog("選択.jsp");\r\n  return r;\r\n}\r\nif (document.all) { document.all("x"); }\r\n</script>\r\n';
const sjisFile = path.join(ws.app, 'pages', 'select.jsp');
fs.writeFileSync(sjisFile, iconv.encode(SJIS, 'cp932'));
const git = gitInit(ws.app);
writeScenario(ws, ORDER_SCENARIO);
writeMigrationConfig(ws, { fix: { allowWrite: true, writableGlobs: ['js/**/*.js', 'pages/**'], maxAttemptsPerFinding: 2 } });
const config = parseConfig(baseConfig);
const mc = () => getMigrationConfig();
const analysis = writeAnalysis(analyzeTarget(mc()));
const findings = JSON.parse(fs.readFileSync(analysis.json, 'utf8')).findings;
const find = (rule, file, cls = 'compat-issue') => findings.find((f) => f.ruleId === rule && f.file === file && f.classification === cls);
const edgeOk = (s) => runEdge(config, s, { adapterFactory: async () => new MockAdapter(orderSite(EDGE_ENGINE)) });
const edgeBad = (s) => runEdge(config, s, { adapterFactory: async () => new MockAdapter(orderSite(EDGE_ENGINE, { amount: '0円' })) });
const smd = find('show-modal-dialog', 'pages/select.jsp');

test('no fix before a passed IE baseline exists (first-pass gate)', () => {
  assert.throws(() => beginAttempt({ findings: [smd.id], files: ['pages/select.jsp'], scenario: 'order', reason: 'r' }), /No passed IE-mode baseline/);
});

test('record and lock the IE baseline', async () => {
  await runIE(config, ORDER_SCENARIO, { adapterFactory: async () => new MockAdapter(orderSite(IE_ENGINE, { dialogMode: 'pending' })) });
  lockBaseline('order', scenarioHash(ORDER_SCENARIO));
});

test('fixes require write permission, scope and evidence', () => {
  writeMigrationConfig(ws, { fix: { allowWrite: false, writableGlobs: ['pages/**'] } });
  assert.throws(() => beginAttempt({ findings: [smd.id], files: ['pages/select.jsp'], scenario: 'order', reason: 'r' }, mc()), /allowWrite is false/);
  writeMigrationConfig(ws, { fix: { allowWrite: true, writableGlobs: ['js/**/*.js', 'pages/**'], maxAttemptsPerFinding: 2 } });
  assert.throws(() => beginAttempt({ findings: [smd.id], files: ['css/legacy.css'], scenario: 'order', reason: 'r' }, mc()), /not covered by fix.writableGlobs/);
  assert.throws(() => beginAttempt({ findings: [], files: ['pages/select.jsp'], scenario: 'order', reason: 'r' }, mc()), /No evidence/);
  assert.throws(() => beginAttempt({ findings: ['F-doesnotexist'], files: ['pages/select.jsp'], scenario: 'order', reason: 'r' }, mc()), /not in analysis/);
  const textOnly = find('document-all', 'js/common.js', 'text-only');
  assert.throws(() => beginAttempt({ findings: [textOnly.id], files: ['js/common.js'], scenario: 'order', reason: 'r' }, mc()), /text-only/);
  assert.throws(() => beginAttempt({ findings: [smd.id], files: ['../outside.js'], scenario: 'order', reason: 'r' }, mc()), /escapes the target/);
  assert.throws(() => beginAttempt({ findings: [smd.id], files: ['pages/select.jsp'], scenario: 'order', reason: ' ' }, mc()), /--reason/);
});

test('dirty files are never taken over', () => {
  fs.appendFileSync(path.join(ws.app, 'js', 'common.js'), '// local change\n');
  assert.throws(() => beginAttempt({ findings: [find('attach-event', 'js/common.js').id], files: ['js/common.js'], scenario: 'order', reason: 'r' }, mc()), /uncommitted changes/);
  git('checkout', '--', 'js/common.js');
});

test('Shift_JIS/CRLF edit keeps encoding, line endings and untouched bytes; then passes regression', async () => {
  const a = beginAttempt({ findings: [smd.id], files: ['pages/select.jsp'], scenario: 'order', reason: 'showModalDialog is removed in Chromium' }, mc());
  assert.equal(a.files[0].encoding, 'cp932');
  assert.equal(a.files[0].eol, 'crlf');
  assert.throws(() => beginAttempt({ findings: [smd.id], files: ['pages/select.jsp'], scenario: 'order', reason: 'x' }, mc()), /still open/);
  assert.throws(() => applyEdits([{ file: 'pages/select.jsp', oldText: 'document.all', newText: 'document.getElementById' }], mc()), /occurs 2 times/);
  assert.throws(() => applyEdits([{ file: 'js/common.js', oldText: 'a', newText: 'b' }], mc()), /not declared/);
  assert.throws(() => applyEdits([{ file: 'pages/select.jsp', oldText: 'not present', newText: 'b' }], mc()), /not found/);
  assert.throws(() => applyEdits([{ file: 'pages/select.jsp', oldText: 'return r;', newText: 'return "😀";' }], mc()), /not representable/);
  applyEdits([{ file: 'pages/select.jsp', findingId: smd.id, oldText: '  var r = window.showModalDialog("選択.jsp");\n', newText: '  // 互換対応: showModalDialog 廃止\n  var r = openModal("選択.jsp");\n' }], mc());
  const bytes = fs.readFileSync(sjisFile);
  const text = iconv.decode(bytes, 'cp932');
  assert.ok(text.includes('// 互換対応: showModalDialog 廃止\r\n  var r = openModal("選択.jsp");\r\n'), text);
  assert.ok(!/(?<!\r)\n/.test(text), 'all line endings stay CRLF');
  assert.ok(bytes.subarray(0, 40).equals(iconv.encode(SJIS, 'cp932').subarray(0, 40)), 'untouched bytes unchanged');
  const v = verifyAttempt(mc());
  assert.equal(v.status, 'verified', JSON.stringify(v.verify));
  const dir = path.join(ws.artifacts, 'fixes', a.id);
  for (const f of ['pre-status.txt', 'pre.diff', 'post.diff', 'post.git.diff', 'edits.json', 'backup/pages/select.jsp']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.ok(fs.readFileSync(path.join(dir, 'post.diff')).length > 0);
  const { attempt, next } = await testAttempt(config, edgeOk, mc());
  assert.equal(attempt.status, 'passed', next);
  assert.match(next, /^PASS/);
  git('commit', '-qam', 'reviewed fix');
});

test('failed attempts are restored, repeated failures stop, budgets are enforced', async () => {
  const kc = find('event-keycode-assign', 'js/common.js');
  const original = fs.readFileSync(path.join(ws.app, 'js', 'common.js'));
  const edit = [{ file: 'js/common.js', findingId: kc.id, oldText: '    window.event.keyCode = 9;', newText: '    focusNext(window.event);' }];
  beginAttempt({ findings: [kc.id], files: ['js/common.js'], scenario: 'order', reason: 'keyCode is read-only' }, mc());
  applyEdits(edit, mc());
  verifyAttempt(mc());
  let res = await testAttempt(config, edgeBad, mc());
  assert.equal(res.attempt.status, 'failed');
  assert.match(res.next, /^FAIL/);
  assert.ok(res.attempt.tests.at(-1).functional.some((f) => f.includes('amount')));
  restoreAttempt();
  assert.ok(fs.readFileSync(path.join(ws.app, 'js', 'common.js')).equals(original), 'restored byte-for-byte');
  beginAttempt({ findings: [kc.id], files: ['js/common.js'], scenario: 'order', reason: 'retry' }, mc());
  applyEdits(edit, mc());
  verifyAttempt(mc());
  res = await testAttempt(config, edgeBad, mc());
  assert.match(res.next, /^STOP \(no progress\)/);
  restoreAttempt();
  assert.throws(() => beginAttempt({ findings: [kc.id], files: ['js/common.js'], scenario: 'order', reason: 'again' }, mc()), /Stop condition: finding .* already had 2 attempts/);
  assert.equal(fixStatus(mc()).budget.used, 3);
});

test('changes outside the declared scope block the attempt', () => {
  const ae = find('attach-event', 'js/common.js');
  beginAttempt({ findings: [ae.id], files: ['js/common.js'], scenario: 'order', reason: 'attachEvent' }, mc());
  applyEdits([{ file: 'js/common.js', findingId: ae.id, oldText: "  el.attachEvent('onclick', onLegacyClick);", newText: "  el.addEventListener('click', onLegacyClick, false);" }], mc());
  fs.appendFileSync(path.join(ws.app, 'css', 'legacy.css'), '/* sneaky */\n');
  const v = verifyAttempt(mc());
  assert.equal(v.status, 'blocked');
  assert.match(v.verify.problems.join(), /Undeclared change outside the attempt scope: css\/legacy.css/);
  git('checkout', '--', 'css/legacy.css');
  restoreAttempt();
});

test('restore refuses to overwrite later manual edits', () => {
  const dd = find('document-domain', 'js/common.js');
  beginAttempt({ findings: [dd.id], files: ['js/common.js'], scenario: 'order', reason: 'document.domain' }, mc());
  applyEdits([{ file: 'js/common.js', findingId: dd.id, oldText: 'document.domain = "example.local";', newText: '/* document.domain removed: same-origin frames */' }], mc());
  fs.appendFileSync(path.join(ws.app, 'js', 'common.js'), '// human edit\n');
  assert.throws(() => restoreAttempt(), /modified after the attempt/);
  git('checkout', '--', 'js/common.js');
});

test('edit-guard hook: protects CLAUDE.md, evidence and the target scope', () => {
  const d = (file, tool = 'Edit') => decide({ tool_name: tool, tool_input: { file_path: file }, cwd: repoRoot }, repoRoot);
  assert.equal(d('CLAUDE.md').allow, false);
  assert.equal(d(path.join(repoRoot, 'artifacts', 'ie', 'x.json')).allow, false);
  assert.equal(d('src/core.ts').allow, true);
  assert.equal(d('/tmp/elsewhere.js').allow, false);
  assert.equal(d(path.join(ws.app, 'js', 'common.js'), 'Write').allow, false, 'no whole-file overwrite of business source');
  assert.equal(d(path.join(ws.app, 'css', 'legacy.css')).allow, false, 'not declared in an open attempt');
  const ae = find('attach-event', 'js/common.js');
  try { restoreAttempt(); } catch {}
  git('checkout', '--', '.');
  beginAttempt({ findings: [ae.id], files: ['js/common.js', 'pages/select.jsp'], scenario: 'order', reason: 'guard test' }, mc());
  assert.equal(d(path.join(ws.app, 'js', 'common.js')).allow, true, 'declared UTF-8 file may be edited directly');
  assert.match(d(path.join(ws.app, 'pages', 'select.jsp')).reason, /cp932.*fix:apply/);
  assert.equal(d('Read', 'Read').allow, true);
});

test('FixRefused is the error type for refusals', () => {
  try { beginAttempt({ findings: [], files: [], scenario: 'order', reason: 'x' }, mc()); assert.fail('expected refusal'); }
  catch (e) { assert.ok(e instanceof FixRefused); }
});
