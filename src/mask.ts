import type { Config, PatternRule } from './core.js';

// Two layers:
//  - redact(): applied before anything is written to disk or printed (secrets, PII).
//  - normalize(): applied only when comparing IE vs Edge (dates, times, ids that legitimately differ per run).

type Compiled = { name: string; re: RegExp; replacement: string };

const SECRET_RULES: PatternRule[] = [
  { name: 'credential-assignment', regex: '((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\\s*[=:]\\s*)("[^"]*"|\'[^\']*\'|[^\\s&;,"\']+)', flags: 'gi', replacement: '$1<REDACTED>' },
  { name: 'bearer', regex: '(Bearer\\s+)[A-Za-z0-9._~+/=-]{8,}', flags: 'gi', replacement: '$1<REDACTED>' },
  { name: 'session-id', regex: '((?:JSESSIONID|ASP\\.NET_SessionId|PHPSESSID|sessionid)[=:]\\s*)[A-Za-z0-9._-]{6,}', flags: 'gi', replacement: '$1<REDACTED>' },
];
const PII_RULES: PatternRule[] = [
  { name: 'email', regex: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', flags: 'g', replacement: '<EMAIL>' },
  { name: 'phone-jp', regex: '(?<![\\d-])0\\d{1,4}-\\d{1,4}-\\d{3,4}(?![\\d-])', flags: 'g', replacement: '<PHONE>' },
  { name: 'card-number', regex: '(?<!\\d)(?:\\d[ -]?){13,16}(?!\\d)', flags: 'g', replacement: '<CARD>' },
];
const DYNAMIC_RULES: PatternRule[] = [
  { name: 'iso-datetime', regex: '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?', flags: 'g', replacement: '<DATETIME>' },
  { name: 'date-ymd', regex: '\\d{4}[/.-]\\d{1,2}[/.-]\\d{1,2}', flags: 'g', replacement: '<DATE>' },
  { name: 'date-ja', regex: '(?:\\d{4}|(?:令和|平成|昭和|R|H|S)\\s?\\d{1,2})年\\s?\\d{1,2}月\\s?\\d{1,2}日', flags: 'g', replacement: '<DATE>' },
  { name: 'time', regex: '(?<!\\d)\\d{1,2}:\\d{2}(?::\\d{2})?(?!\\d)', flags: 'g', replacement: '<TIME>' },
  { name: 'uuid', regex: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', flags: 'gi', replacement: '<UUID>' },
  { name: 'jsessionid-url', regex: ';jsessionid=[^?#\\s]+', flags: 'gi', replacement: ';jsessionid=<ID>' },
];

function compile(rules: PatternRule[], fallback: string): Compiled[] {
  return rules.map((r) => {
    const flags = r.flags ?? 'g';
    return { name: r.name, re: new RegExp(r.regex, flags.includes('g') ? flags : flags + 'g'), replacement: r.replacement ?? fallback };
  });
}
function luhnOk(text: string): boolean {
  const digits = text.replace(/\D/g, '');
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return digits.length >= 13 && sum % 10 === 0;
}
function escapeRe(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export class Masker {
  private readonly redactRules: Compiled[];
  private readonly normalizeRules: Compiled[];
  private readonly secrets = new Set<string>();

  constructor(masking: Config['masking']) {
    this.redactRules = compile([...SECRET_RULES, ...(masking.redactPII ? PII_RULES : []), ...masking.redact], '<REDACTED>');
    this.normalizeRules = compile([...(masking.normalizeDynamic ? DYNAMIC_RULES : []), ...masking.normalize], '<MASKED>');
  }
  addSecret(value: string): void { if (value && value.length >= 3) this.secrets.add(value); }
  addSecrets(values: Iterable<string>): void { for (const v of values) this.addSecret(v); }

  redact(text: string): string {
    let out = text;
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escapeRe(s), 'g'), '<SECRET>');
    for (const r of this.redactRules) {
      out = out.replace(r.re, (...args: unknown[]) => {
        const match = args[0] as string;
        if (r.name === 'card-number' && !luhnOk(match)) return match;
        return match.replace(new RegExp(r.re.source, r.re.flags.replace('g', '')), r.replacement);
      });
    }
    return out;
  }
  normalize(text: string): string {
    let out = text.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0\u3000]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
    for (const r of this.normalizeRules) out = out.replace(r.re, r.replacement);
    return out;
  }
  /** Deep-redacts all strings in a JSON-compatible value. */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactDeep(v)])) as T;
    }
    return value;
  }
}
