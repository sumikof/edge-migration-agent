import iconv from 'iconv-lite';
import type { Encoding, MigrationConfig } from './target.js';
import { matchesAny } from './target.js';

// Legacy sources are frequently Shift_JIS (in practice Windows-31J/CP932) with CRLF.
// Files are decoded losslessly or not edited at all: every decode is checked by
// re-encoding and comparing bytes.

export type Eol = 'crlf' | 'lf' | 'cr' | 'mixed' | 'none';
export type DecodedSource = {
  text: string;
  encoding: Encoding | 'binary-latin1';
  bom: boolean;
  eol: Eol;
  /** True when encode(text) reproduces the original bytes exactly; edits are only allowed then. */
  lossless: boolean;
  declaredCharset?: string;
  source: 'bom' | 'override' | 'declared' | 'detected' | 'default' | 'fallback';
};

const ICONV_NAME: Record<Encoding, string> = { 'utf-8': 'utf8', shift_jis: 'cp932', cp932: 'cp932', 'euc-jp': 'eucjp' };

export function normalizeCharset(name: string): Encoding | undefined {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (n === 'utf8') return 'utf-8';
  if (['shiftjis', 'sjis', 'windows31j', 'cp932', 'ms932', 'xsjis', 'mskanji'].includes(n)) return 'cp932';
  if (['eucjp', 'xeucjp'].includes(n)) return 'euc-jp';
  return undefined;
}
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const kinds = [crlf, lf, cr].filter((n) => n > 0).length;
  if (kinds === 0) return 'none';
  if (kinds > 1) return 'mixed';
  return crlf ? 'crlf' : lf ? 'lf' : 'cr';
}
/** Charset declared inside the file (JSP page directive, meta tag, @charset, XML prolog). ASCII-safe scan. */
export function declaredCharset(bytes: Buffer): string | undefined {
  const head = bytes.subarray(0, 8192).toString('latin1');
  const m = head.match(/pageEncoding\s*=\s*["']([\w.-]+)["']/i)
    ?? head.match(/contentType\s*=\s*["'][^"']*charset\s*=\s*([\w.-]+)/i)
    ?? head.match(/<meta[^>]+charset\s*=\s*["']?([\w.-]+)/i)
    ?? head.match(/@charset\s+["']([\w.-]+)["']/i)
    ?? head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w.-]+)["']/i);
  return m?.[1];
}
function isAscii(bytes: Buffer): boolean {
  for (const b of bytes) if (b > 0x7f) return false;
  return true;
}
function validUtf8(bytes: Buffer): boolean {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}
function roundTrips(bytes: Buffer, enc: Encoding, bom: boolean): { text: string; ok: boolean } {
  const body = bom ? bytes.subarray(3) : bytes;
  const text = iconv.decode(body, ICONV_NAME[enc]);
  const back = iconv.encode(text, ICONV_NAME[enc]);
  return { text, ok: Buffer.compare(back, body) === 0 };
}

export function decodeSource(bytes: Buffer, rel: string, mc: MigrationConfig['targetApp']): DecodedSource {
  const declared = declaredCharset(bytes);
  const declaredEnc = declared ? normalizeCharset(declared) : undefined;
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const make = (enc: Encoding, source: DecodedSource['source']): DecodedSource | undefined => {
    const r = roundTrips(bytes, enc, bom && enc === 'utf-8');
    if (!r.ok && source !== 'override') return undefined;
    return { text: r.text, encoding: enc, bom: bom && enc === 'utf-8', eol: detectEol(r.text), lossless: r.ok, declaredCharset: declared, source };
  };
  const override = Object.entries(mc.encodingOverrides).find(([glob]) => matchesAny(rel, [glob]));
  if (override) return make(override[1], 'override')!;
  if (bom) { const r = make('utf-8', 'bom'); if (r) return r; }
  if (isAscii(bytes)) {
    // Pure ASCII decodes identically everywhere; remember the charset new text must be written in.
    const enc = declaredEnc ?? (mc.defaultEncoding === 'auto' ? 'utf-8' : mc.defaultEncoding);
    return make(enc, declaredEnc ? 'declared' : 'default')!;
  }
  const candidates: Array<[Encoding, DecodedSource['source']]> = [];
  if (mc.defaultEncoding !== 'auto') candidates.push([mc.defaultEncoding, 'default']);
  if (declaredEnc) candidates.push([declaredEnc, 'declared']);
  if (validUtf8(bytes)) candidates.push(['utf-8', 'detected']);
  candidates.push(['cp932', 'detected'], ['euc-jp', 'detected']);
  for (const [enc, source] of candidates) {
    if (enc === 'utf-8' && !validUtf8(bytes.subarray(bom ? 3 : 0))) continue;
    const r = make(enc, source);
    if (r) return r;
  }
  return { text: bytes.toString('latin1'), encoding: 'binary-latin1', bom: false, eol: detectEol(bytes.toString('latin1')), lossless: false, declaredCharset: declared, source: 'fallback' };
}

/** Re-encodes text with the original encoding/BOM. Throws when characters cannot be represented. */
export function encodeSource(text: string, original: DecodedSource): Buffer {
  if (original.encoding === 'binary-latin1') throw new Error('File encoding could not be determined losslessly; refusing to write it.');
  const enc = ICONV_NAME[original.encoding];
  const body = iconv.encode(text, enc);
  if (iconv.decode(body, enc) !== text) {
    const bad = [...text].find((ch) => iconv.decode(iconv.encode(ch, enc), enc) !== ch);
    throw new Error(`Text contains a character not representable in ${original.encoding}: ${JSON.stringify(bad)}`);
  }
  return original.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}
/** Converts replacement text to the file's line ending convention. */
export function applyEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n?/g, '\n');
  if (eol === 'crlf') return lf.replace(/\n/g, '\r\n');
  if (eol === 'cr') return lf.replace(/\n/g, '\r');
  return lf;
}
