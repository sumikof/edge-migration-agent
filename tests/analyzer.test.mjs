import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import iconv from 'iconv-lite';
import { analyzeTarget, analyzeText, writeAnalysis, loadLatestAnalysis } from '../src/analyzer.ts';
import { decodeSource, encodeSource, applyEol } from '../src/source-text.ts';
import { getMigrationConfig, resolveTargetRoot, parseMigrationConfig, TargetNotConfigured } from '../src/target.ts';
import { makeWorkspace, cleanup, writeMigrationConfig, copyFixtureApp, repoRoot } from './helpers/workspace.mjs';

const ws = makeWorkspace();
after(() => cleanup(ws));
copyFixtureApp(ws);
const SJIS_JSP = '<%@ page contentType="text/html; charset=Windows-31J" pageEncoding="Windows-31J" %>\r\n<html><body>\r\n<script>\r\n// 受注画面 ①\r\nfunction 計算() {\r\n  if (document.all) { document.all("合計").innerText = "０円"; }\r\n  window.showModalDialog("選択.jsp");\r\n}\r\n</script>\r\n<p>注文</p>\r\n</body></html>\r\n';
fs.writeFileSync(path.join(ws.app, 'pages', 'order_sjis.jsp'), iconv.encode(SJIS_JSP, 'cp932'));
fs.writeFileSync(path.join(ws.app, 'js', 'nocharset.js'), iconv.encode('// 共通\nvar a = "ｶﾅ";\n', 'cp932'));
const hashTree = (dir) => {
  const h = crypto.createHash('sha256');
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else h.update(p).update(fs.readFileSync(p)); } };
  walk(dir);
  return h.digest('hex');
};
const tc = parseMigrationConfig({ targetApp: { sourceRoot: '' }, fix: {} }).targetApp;

test('analysis is refused when no target directory is configured', () => {
  writeMigrationConfig(ws, { targetApp: { sourceRoot: '' } });
  assert.throws(() => analyzeTarget(getMigrationConfig()), TargetNotConfigured);
});

test('unsafe target directories are refused', () => {
  const mc = (root) => parseMigrationConfig({ targetApp: { sourceRoot: root }, fix: {} });
  assert.throws(() => resolveTargetRoot(mc(repoRoot), repoRoot), /inside the migration harness/);
  assert.throws(() => resolveTargetRoot(mc(path.join(repoRoot, 'src')), repoRoot), /inside the migration harness/);
  assert.throws(() => resolveTargetRoot(mc(path.dirname(repoRoot)), repoRoot), /contains the migration harness/);
  assert.throws(() => resolveTargetRoot(mc(os.homedir()), repoRoot), /home|harness/);
  assert.throws(() => resolveTargetRoot(mc('relative/path'), repoRoot), /absolute path/);
  assert.throws(() => resolveTargetRoot(mc(path.join(ws.base, 'missing')), repoRoot), /does not exist/);
  if (process.platform !== 'win32') assert.throws(() => resolveTargetRoot(mc('/etc'), repoRoot), /system directory/);
  assert.equal(resolveTargetRoot(mc(ws.app), repoRoot), ws.app);
});

test('analyzes JS/JSP/HTML/CSS read-only and classifies findings', () => {
  writeMigrationConfig(ws);
  const before = hashTree(ws.app);
  const report = analyzeTarget(getMigrationConfig());
  assert.equal(hashTree(ws.app), before, 'analysis must not modify the target');
  const by = (rule, file) => report.findings.filter((f) => f.ruleId === rule && (!file || f.file === file));
  // Real problem vs string match.
  assert.equal(by('document-all', 'js/common.js').find((f) => f.line === 1).classification, 'text-only');
  assert.equal(by('document-all', 'js/common.js').find((f) => f.line === 2).classification, 'compat-issue');
  // Fallback-guarded attachEvent vs unguarded.
  assert.equal(by('attach-event').find((f) => f.line === 8).classification, 'feature-detected');
  assert.equal(by('attach-event').find((f) => f.line === 13).classification, 'compat-issue');
  // XMLHTTP with XMLHttpRequest fallback vs FileSystemObject.
  assert.equal(by('activex-object').find((f) => /XMLHTTP/.test(f.snippet)).classification, 'feature-detected');
  const fso = by('activex-object').find((f) => /FileSystemObject/.test(f.snippet));
  assert.equal(fso.priority, 'P1');
  assert.match(fso.recommendation, /server-side/);
  assert.equal(by('event-keycode-assign')[0].priority, 'P2');
  assert.equal(by('show-modal-dialog', 'js/common.js')[0].priority, 'P1');
  assert.equal(by('show-modal-dialog', 'pages/order.html')[0].classification, 'text-only');
  assert.ok(by('vbscript-block').length === 1 && by('vbscript-url').length === 1);
  assert.ok(by('conditional-comment').length === 1);
  assert.ok(by('object-classid')[0].impact.note.includes('document.write'));
  assert.ok(by('ie-only-event-attr').length === 1);
  assert.ok(by('css-expression').length === 1 && by('css-behavior').length === 1);
  assert.equal(by('css-filter').find((f) => f.line === 1).classification, 'text-only');
  assert.ok(by('document-domain').length === 1);
  assert.ok(by('cross-frame-dom').length >= 1);
  // Impact scope: the script is referenced by the page.
  assert.deepEqual(by('attach-event')[0].impact.referencedBy, ['pages/order.html']);
  assert.equal(by('attach-event').find((f) => f.line === 13).impact.enclosingFunction, 'bindLegacy');
  for (const f of report.findings) {
    for (const k of ['file', 'line', 'title', 'impact', 'recommendation', 'priority']) assert.ok(f[k] !== undefined, `${f.id} lacks ${k}`);
  }
});

test('Shift_JIS (Windows-31J) CRLF JSP is decoded losslessly and analyzed with correct lines', () => {
  const report = analyzeTarget(getMigrationConfig());
  const info = report.files.find((f) => f.file === 'pages/order_sjis.jsp');
  assert.equal(info.encoding, 'cp932');
  assert.equal(info.eol, 'crlf');
  assert.equal(info.lossless, true);
  const f = report.findings.filter((x) => x.file === 'pages/order_sjis.jsp');
  assert.equal(f.find((x) => x.ruleId === 'document-all' && x.classification === 'compat-issue').line, 6);
  assert.equal(f.find((x) => x.ruleId === 'show-modal-dialog').line, 7);
  assert.equal(f.find((x) => x.ruleId === 'show-modal-dialog').impact.enclosingFunction, '計算');
  const undeclared = report.findings.find((x) => x.file === 'js/nocharset.js' && x.ruleId === 'encoding-undeclared');
  assert.ok(undeclared, 'non-UTF-8 script without charset is reported');
});

test('scope can be narrowed and output is written outside the target', () => {
  const report = analyzeTarget(getMigrationConfig(), { scope: ['**/*.css'] });
  assert.ok(report.files.every((f) => f.file.endsWith('.css')));
  const out = writeAnalysis(report);
  assert.ok(out.dir.startsWith(ws.artifacts));
  assert.match(fs.readFileSync(out.markdown, 'utf8'), /\| ID \| Pri \|/);
  assert.equal(loadLatestAnalysis().analysisId, report.analysisId);
});

test('finding ids are stable across line shifts', () => {
  const d1 = decodeSource(Buffer.from('el.attachEvent("onclick", f);\n'), 'a.js', tc);
  const d2 = decodeSource(Buffer.from('\n\nel.attachEvent("onclick", f);\n'), 'a.js', tc);
  assert.equal(analyzeText('a.js', d1)[0].id, analyzeText('a.js', d2)[0].id);
});

test('encoding round trip keeps bytes, BOM and line endings', () => {
  const bytes = iconv.encode('あ\r\nい①\r\n', 'cp932');
  const d = decodeSource(bytes, 'x.jsp', tc);
  assert.equal(d.encoding, 'cp932');
  assert.equal(Buffer.compare(encodeSource(d.text, d), bytes), 0);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\nb', 'utf8')]);
  const db = decodeSource(bom, 'x.js', tc);
  assert.equal(db.bom, true);
  assert.equal(Buffer.compare(encodeSource(db.text, db), bom), 0);
  assert.throws(() => encodeSource('😀', d), /not representable/);
  assert.equal(applyEol('a\nb\r\nc', 'crlf'), 'a\r\nb\r\nc');
});
