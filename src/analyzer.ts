import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { artifactsRoot, newRunId, saveJson } from './core.js';
import { Masker } from './mask.js';
import { Classification, Context, Lang, MatchCtx, RULES, Rule, Severity } from './analyzer-rules.js';
import { DecodedSource, decodeSource, normalizeCharset } from './source-text.js';
import { MigrationConfig, listTargetFiles, resolveTargetRoot } from './target.js';

// Read-only static analysis of the external target application.
// It never writes into the target directory.

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type Finding = {
  id: string;
  ruleId: string;
  category: string;
  title: string;
  file: string;
  line: number;
  column: number;
  snippet: string;
  context: Context;
  language: Lang | 'file';
  classification: Classification;
  severity: Severity;
  priority: Priority;
  /** 影響範囲 */
  impact: { summary: string; enclosingFunction?: string; referencedBy: string[]; note?: string };
  /** 推奨修正方法 */
  recommendation: string;
};
export type FileInfo = { file: string; encoding: string; bom: boolean; eol: string; lossless: boolean; declaredCharset?: string; findings: number };
export type AnalysisReport = {
  schemaVersion: 1;
  analysisId: string;
  createdAt: string;
  targetRoot: string;
  scope: { include: string[]; exclude: string[] };
  files: FileInfo[];
  findings: Finding[];
  summary: {
    files: number; findings: number;
    byPriority: Record<Priority, number>;
    byClassification: Record<Classification, number>;
    byCategory: Record<string, number>;
  };
};

type Region = { start: number; end: number; lang: Lang; ctx: Context };

const MARKUP_EXT = /\.(html?|jsp|jspf|tag|inc|asp|htc|xhtml)$/i;
function fileLang(file: string): Lang | 'markup' {
  if (/\.css$/i.test(file)) return 'css';
  if (/\.vbs$/i.test(file)) return 'vbscript';
  if (MARKUP_EXT.test(file)) return 'markup';
  return 'js';
}

/** Splits a C-like source (JS/CSS) region into code/comment/string sub-regions. */
function lexCLike(text: string, start: number, end: number, lang: 'js' | 'css', out: Region[]): void {
  let i = start, codeStart = start;
  const push = (s: number, e: number, ctx: Context) => { if (e > s) out.push({ start: s, end: e, lang, ctx }); };
  let prevSignificant = '';
  while (i < end) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '*') {
      push(codeStart, i, 'code');
      const close = text.indexOf('*/', i + 2);
      const stop = close < 0 || close + 2 > end ? end : close + 2;
      push(i, stop, 'comment'); i = codeStart = stop; continue;
    }
    if (lang === 'js' && c === '/' && n === '/') {
      push(codeStart, i, 'code');
      let stop = i; while (stop < end && text[stop] !== '\n' && text[stop] !== '\r') stop++;
      push(i, stop, 'comment'); i = codeStart = stop; continue;
    }
    if (c === '"' || c === "'" || (lang === 'js' && c === '`')) {
      push(codeStart, i, 'code');
      let j = i + 1;
      while (j < end && text[j] !== c) {
        if (text[j] === '\\') j++;
        else if (c !== '`' && (text[j] === '\n' || text[j] === '\r')) break;
        j++;
      }
      const stop = Math.min(j + 1, end);
      push(i, stop, 'string'); i = codeStart = stop; prevSignificant = 'x'; continue;
    }
    if (lang === 'js' && c === '/' && /^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(prevSignificant)) {
      // Regular expression literal.
      push(codeStart, i, 'code');
      let j = i + 1, inClass = false;
      while (j < end && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j++;
      }
      const stop = Math.min(j + 1, end);
      push(i, stop, 'string'); i = codeStart = stop; prevSignificant = 'x'; continue;
    }
    if (!/\s/.test(c)) prevSignificant = /[\w$)\]]/.test(c) ? 'x' : c;
    i++;
  }
  push(codeStart, end, 'code');
}

/** Region map for markup files: script/style blocks, event handler attributes, JSP sections, comments. */
function segmentMarkup(text: string): Region[] {
  const spans: Array<{ start: number; end: number; kind: 'js' | 'css' | 'vbscript' | 'comment' | 'server' }> = [];
  const add = (start: number, end: number, kind: typeof spans[number]['kind']) => { if (end > start) spans.push({ start, end, kind }); };
  let m: RegExpExecArray | null;
  const jsp = /<%--[\s\S]*?--%>|<%[\s\S]*?%>/g;
  while ((m = jsp.exec(text))) add(m.index, m.index + m[0].length, m[0].startsWith('<%--') ? 'comment' : 'server');
  const comments = /<!--(?!\[if)[\s\S]*?-->/g;
  while ((m = comments.exec(text))) add(m.index, m.index + m[0].length, 'comment');
  const blocks = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  while ((m = blocks.exec(text))) {
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    const bodyEnd = bodyStart + m[3].length;
    const kind = m[1].toLowerCase() === 'style' ? 'css' : /vbscript/i.test(m[2]) ? 'vbscript' : 'js';
    add(bodyStart, bodyEnd, kind);
  }
  const attrs = /\b(on\w+|style)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  while ((m = attrs.exec(text))) {
    const valStart = m.index + m[0].indexOf(m[2]) + 1;
    add(valStart, valStart + (m[3] ?? m[4]).length, m[1].toLowerCase() === 'style' ? 'css' : 'js');
  }
  const jsUrls = /\bhref\s*=\s*["']javascript:([^"']*)["']/gi;
  while ((m = jsUrls.exec(text))) { const s = m.index + m[0].indexOf('javascript:') + 11; add(s, s + m[1].length, 'js'); }
  // Earlier/outer spans win; drop spans nested inside an already accepted span (e.g. attrs inside <script> text).
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: typeof spans = [];
  for (const s of spans) {
    const last = accepted[accepted.length - 1];
    if (last && s.start < last.end) continue;
    accepted.push(s);
  }
  const regions: Region[] = [];
  let pos = 0;
  for (const s of accepted) {
    if (s.start > pos) regions.push({ start: pos, end: s.start, lang: 'markup', ctx: 'markup' });
    if (s.kind === 'js' || s.kind === 'css') lexCLike(text, s.start, s.end, s.kind, regions);
    else if (s.kind === 'vbscript') regions.push({ start: s.start, end: s.end, lang: 'vbscript', ctx: 'code' });
    else regions.push({ start: s.start, end: s.end, lang: 'markup', ctx: s.kind });
    pos = s.end;
  }
  if (pos < text.length) regions.push({ start: pos, end: text.length, lang: 'markup', ctx: 'markup' });
  return regions;
}

export function segment(file: string, text: string): Region[] {
  const lang = fileLang(file);
  if (lang === 'markup') return segmentMarkup(text);
  if (lang === 'vbscript') return [{ start: 0, end: text.length, lang: 'vbscript', ctx: 'code' }];
  const out: Region[] = [];
  lexCLike(text, 0, text.length, lang, out);
  return out;
}

function regionAt(regions: Region[], offset: number): Region {
  let lo = 0, hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < regions[mid].start) hi = mid - 1;
    else if (offset >= regions[mid].end) lo = mid + 1;
    else return regions[mid];
  }
  return { start: offset, end: offset, lang: 'markup', ctx: 'markup' };
}
/** Same-length text where comments and strings are blanked (keeps columns aligned). */
function blankNonCode(text: string, regions: Region[]): string {
  const chars = text.split('');
  for (const r of regions) {
    if (r.ctx === 'comment' || r.ctx === 'string' || r.ctx === 'server') {
      for (let i = r.start; i < r.end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  }
  return chars.join('');
}
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
    else if (text[i] === '\r' && text[i + 1] !== '\n') starts.push(i + 1);
  }
  return starts;
}
function lineOf(starts: number[], offset: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo;
}
function lineText(text: string, starts: number[], line: number): string {
  const end = line + 1 < starts.length ? starts[line + 1] : text.length;
  return text.slice(starts[line], end).replace(/\r?\n$|\r$/, '');
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export function priorityOf(severity: Severity, classification: Classification): Priority {
  if (classification === 'text-only') return 'P4';
  let p = { critical: 1, high: 2, medium: 3, low: 4, info: 4 }[severity];
  if (classification === 'deprecated-works') p = Math.max(p, 3);
  if (classification === 'feature-detected') p = Math.max(p + 1, 3);
  return `P${Math.min(p, 4)}` as Priority;
}
function enclosingFunction(code: string, starts: number[], line: number): string | undefined {
  for (let l = line; l >= Math.max(0, line - 200); l--) {
    const t = lineText(code, starts, l);
    const m = t.match(/function\s+([\p{L}\p{N}_$]+)\s*\(/u) ?? t.match(/([\p{L}\p{N}_$.]+)\s*[:=]\s*function\b/u) ?? t.match(/\bSub\s+([\p{L}\p{N}_]+)|\bFunction\s+([\p{L}\p{N}_]+)/iu);
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

export type AnalyzeOptions = { scope?: string[]; rules?: string[]; masking?: ConstructorParameters<typeof Masker>[0] };

/** Analyzes a single file's decoded text. Exposed for tests. */
export function analyzeText(file: string, decoded: DecodedSource, opts: { rules?: string[] } = {}): Finding[] {
  const text = decoded.text;
  const regions = segment(file, text);
  const code = blankNonCode(text, regions);
  const starts = lineStarts(text);
  const findings: Finding[] = [];
  const kind = fileLang(file);
  const seen = new Map<string, number>();
  for (const rule of RULES) {
    if (opts.rules?.length && !opts.rules.includes(rule.id)) continue;
    if (!rule.langs.length) continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const region = regionAt(regions, m.index);
      const lang: Lang = region.lang;
      const inLang = rule.langs.includes(lang);
      const executable = region.ctx === 'code' || (region.ctx === 'markup' && lang === 'markup');
      // Markup emitted from script (document.write / innerHTML strings) is still rendered by the browser.
      const markupInScript = rule.langs.includes('markup') && lang === 'js' && region.ctx === 'string';
      let mode: 'classify' | 'text-only';
      if (rule.anyContext) {
        if (!inLang && !rule.langs.includes(kind)) continue;
        mode = 'classify';
      } else if ((inLang && executable) || markupInScript) mode = 'classify';
      else if (inLang || (rule.langs.includes('js') && region.ctx !== 'code')) mode = 'text-only';
      else continue;
      const line = lineOf(starts, m.index);
      const col = m.index - starts[line];
      const codeLine = lineText(code, starts, line);
      const around: string[] = [], rawAround: string[] = [];
      for (let l = Math.max(0, line - 4); l <= Math.min(starts.length - 1, line + 4); l++) {
        around.push(lineText(code, starts, l));
        rawAround.push(lineText(text, starts, l));
      }
      const ctx: MatchCtx = { match: m, col, codeLine, around: around.join('\n'), rawAround: rawAround.join('\n'), context: region.ctx, lang, fileKind: kind };
      let classification: Classification = 'compat-issue';
      let severity = rule.severity;
      let note: string | undefined = markupInScript ? 'Markup generated from a JavaScript string (document.write/innerHTML).' : undefined;
      let recommendation = rule.recommendation;
      if (mode === 'text-only') {
        classification = 'text-only';
        severity = 'info';
        note = `Matched inside ${region.ctx === 'markup' ? 'markup text' : region.ctx === 'server' ? 'server-side (JSP) code' : `a ${region.ctx}`}; not executed browser code.`;
      } else if (rule.classify && !markupInScript) {
        const v = rule.classify(ctx);
        if (v.skip) continue;
        classification = v.classification ?? classification;
        severity = v.severity ?? severity;
        note = v.note;
        recommendation = v.recommendation ?? recommendation;
      }
      const rawLine = lineText(text, starts, line);
      const key = `${rule.id}|${file}|${rawLine.trim()}`;
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      if (rule.oncePerFile && findings.some((f) => f.ruleId === rule.id)) continue;
      findings.push({
        id: 'F-' + crypto.createHash('sha1').update(`${key}|${occurrence}|${col}`).digest('hex').slice(0, 10),
        ruleId: rule.id, category: rule.category, title: rule.title, file, line: line + 1, column: col + 1,
        snippet: rawLine.trim().slice(0, 240), context: region.ctx, language: lang, classification, severity,
        priority: priorityOf(severity, classification),
        impact: { summary: rule.impact, enclosingFunction: lang === 'js' || lang === 'vbscript' ? enclosingFunction(code, starts, line) : undefined, referencedBy: [], note },
        recommendation,
      });
    }
  }
  findings.push(...encodingFindings(file, decoded));
  // A text-only hit that coincides with a real finding of the same category is noise.
  const real = new Set(findings.filter((f) => f.classification !== 'text-only').map((f) => `${f.line}|${f.category}`));
  return findings.filter((f) => f.classification !== 'text-only' || !real.has(`${f.line}|${f.category}`)).sort((a, b) => a.line - b.line || a.column - b.column);
}

function encodingFindings(file: string, d: DecodedSource): Finding[] {
  const out: Finding[] = [];
  const make = (ruleId: string, note: string, severity?: Severity): Finding => {
    const rule = RULES.find((r) => r.id === ruleId)!;
    const sev = severity ?? rule.severity;
    return {
      id: 'F-' + crypto.createHash('sha1').update(`${ruleId}|${file}`).digest('hex').slice(0, 10),
      ruleId, category: rule.category, title: rule.title, file, line: 1, column: 1, snippet: '', context: 'code', language: 'file',
      classification: 'compat-issue', severity: sev, priority: priorityOf(sev, 'compat-issue'),
      impact: { summary: rule.impact, referencedBy: [], note }, recommendation: rule.recommendation,
    };
  };
  const nonUtf8 = d.encoding !== 'utf-8' && d.encoding !== 'binary-latin1';
  const declared = d.declaredCharset ? normalizeCharset(d.declaredCharset) : undefined;
  const markup = MARKUP_EXT.test(file);
  if (d.encoding === 'binary-latin1') out.push(make('encoding-mismatch', 'File bytes could not be decoded losslessly as UTF-8, CP932 or EUC-JP; it will not be edited by the fix tool.'));
  else if (declared && declared !== d.encoding && d.source !== 'declared') {
    const both932 = (declared === 'cp932' && d.encoding === 'shift_jis') || (declared === 'shift_jis' && d.encoding === 'cp932');
    if (!both932) out.push(make('encoding-mismatch', `Declared ${d.declaredCharset} but bytes decode as ${d.encoding}.`));
  } else if (nonUtf8 && !declared && (markup || /\.(js|css)$/i.test(file))) {
    out.push(make('encoding-undeclared', `File is ${d.encoding} and declares no charset.`, markup ? 'medium' : 'low'));
  }
  if (d.eol === 'mixed') out.push(make('encoding-mixed-eol', 'File mixes CRLF/LF line endings.'));
  return out;
}

/** Fills impact.referencedBy: which pages include each script/style/component file. */
function linkReferences(findings: Finding[], pages: Map<string, string>): void {
  const cache = new Map<string, string[]>();
  for (const f of findings) {
    if (MARKUP_EXT.test(f.file) && !/\.htc$/i.test(f.file)) { f.impact.referencedBy = [f.file]; continue; }
    if (!cache.has(f.file)) {
      const base = path.posix.basename(f.file).toLowerCase();
      const refs: string[] = [];
      for (const [page, lower] of pages) if (page !== f.file && lower.includes(base)) refs.push(page);
      cache.set(f.file, refs.slice(0, 30));
    }
    f.impact.referencedBy = cache.get(f.file)!;
  }
}

export function analyzeTarget(mc: MigrationConfig, opts: AnalyzeOptions = {}): AnalysisReport {
  const targetRoot = resolveTargetRoot(mc);
  const files = listTargetFiles(mc, targetRoot, opts.scope);
  const masker = opts.masking ? new Masker(opts.masking) : undefined;
  const findings: Finding[] = [];
  const infos: FileInfo[] = [];
  const pages = new Map<string, string>();
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(targetRoot, rel));
    const decoded = decodeSource(bytes, rel, mc.targetApp);
    if (MARKUP_EXT.test(rel)) pages.set(rel, decoded.text.toLowerCase());
    const found = analyzeText(rel, decoded, { rules: opts.rules });
    if (masker) for (const f of found) f.snippet = masker.redact(f.snippet);
    findings.push(...found);
    infos.push({ file: rel, encoding: decoded.encoding, bom: decoded.bom, eol: decoded.eol, lossless: decoded.lossless, declaredCharset: decoded.declaredCharset, findings: found.length });
  }
  linkReferences(findings, pages);
  findings.sort((a, b) => a.priority.localeCompare(b.priority) || SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.file.localeCompare(b.file) || a.line - b.line);
  const count = <K extends string>(keys: readonly K[], pick: (f: Finding) => string) =>
    Object.fromEntries(keys.map((k) => [k, findings.filter((f) => pick(f) === k).length])) as Record<K, number>;
  const categories = [...new Set(findings.map((f) => f.category))].sort();
  return {
    schemaVersion: 1,
    analysisId: newRunId('analysis'),
    createdAt: new Date().toISOString(),
    targetRoot,
    scope: { include: opts.scope?.length ? opts.scope : mc.targetApp.include, exclude: mc.targetApp.exclude },
    files: infos,
    findings,
    summary: {
      files: files.length, findings: findings.length,
      byPriority: count(['P1', 'P2', 'P3', 'P4'] as const, (f) => f.priority),
      byClassification: count(['compat-issue', 'deprecated-works', 'feature-detected', 'text-only'] as const, (f) => f.classification),
      byCategory: count(categories, (f) => f.category),
    },
  };
}

export function analysisDir(): string { return path.join(artifactsRoot(), 'analysis'); }

export function writeAnalysis(report: AnalysisReport): { dir: string; json: string; markdown: string } {
  const dir = path.join(analysisDir(), report.analysisId);
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, 'findings.json');
  saveJson(json, report);
  const markdown = path.join(dir, 'summary.md');
  fs.writeFileSync(markdown, renderMarkdown(report), 'utf8');
  saveJson(path.join(analysisDir(), 'latest.json'), { analysisId: report.analysisId, createdAt: report.createdAt, findings: report.findings.length });
  return { dir, json, markdown };
}
export function loadLatestAnalysis(): AnalysisReport | undefined {
  const pointer = path.join(analysisDir(), 'latest.json');
  if (!fs.existsSync(pointer)) return undefined;
  const { analysisId } = JSON.parse(fs.readFileSync(pointer, 'utf8')) as { analysisId: string };
  const file = path.join(analysisDir(), analysisId, 'findings.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as AnalysisReport : undefined;
}

function md(s: string): string { return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }
export function renderMarkdown(r: AnalysisReport): string {
  const lines = [
    `# IE compatibility analysis ${r.analysisId}`, '',
    `- Target: \`${r.targetRoot}\``, `- Files analyzed: ${r.summary.files}`, `- Findings: ${r.summary.findings}`,
    `- Priority: ${Object.entries(r.summary.byPriority).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `- Classification: ${Object.entries(r.summary.byClassification).map(([k, v]) => `${k}=${v}`).join(', ')}`, '',
    'Classification: `compat-issue` = executed code that breaks/changes in Chromium; `deprecated-works` = non-standard but works; `feature-detected` = guarded check, verify the non-IE branch; `text-only` = comment/string/markup text (simple string match).', '',
    '| ID | Pri | Class | File:Line | Issue | Impact scope | Recommendation |', '|---|---|---|---|---|---|---|',
  ];
  for (const f of r.findings) {
    const scope = [f.impact.enclosingFunction ? `fn ${f.impact.enclosingFunction}` : '', f.impact.referencedBy.length ? `pages: ${f.impact.referencedBy.slice(0, 5).join(', ')}${f.impact.referencedBy.length > 5 ? '...' : ''}` : ''].filter(Boolean).join('; ');
    lines.push(`| ${f.id} | ${f.priority} | ${f.classification} | ${md(f.file)}:${f.line} | ${md(f.title)}${f.impact.note ? ` - ${md(f.impact.note)}` : ''} | ${md(scope || '-')} | ${md(f.recommendation)} |`);
  }
  lines.push('', '## Files', '', '| File | Encoding | BOM | EOL | Editable | Findings |', '|---|---|---|---|---|---|');
  for (const f of r.files) lines.push(`| ${md(f.file)} | ${f.encoding}${f.declaredCharset ? ` (declares ${f.declaredCharset})` : ''} | ${f.bom ? 'yes' : 'no'} | ${f.eol} | ${f.lossless ? 'yes' : 'NO'} | ${f.findings} |`);
  return lines.join('\n') + '\n';
}
