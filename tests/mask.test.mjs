import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Masker } from '../src/mask.ts';
import { DEFAULTS } from '../src/core.ts';

const masker = () => new Masker({ ...DEFAULTS.masking, redact: [{ name: 'cust', regex: 'C\\d{6}', replacement: '<CUST>' }], normalize: [{ name: 'slip', regex: '伝票\\d+', replacement: '伝票<N>' }] });

test('redacts secrets, PII and configured patterns', () => {
  const m = masker();
  m.addSecret('s3cr3t-pass');
  const out = m.redact('login s3cr3t-pass password=abc123 Bearer abcdefghijkl mail taro@example.com tel 03-1234-5678 card 4111 1111 1111 1111 C123456 JSESSIONID=ABCDEF123456');
  for (const leaked of ['s3cr3t-pass', 'abc123', 'abcdefghijkl', 'taro@example.com', '03-1234-5678', '4111 1111 1111 1111', 'C123456', 'ABCDEF123456']) {
    assert.ok(!out.includes(leaked), `${leaked} leaked: ${out}`);
  }
  assert.match(out, /<SECRET>/);
  assert.match(out, /<EMAIL>/);
});

test('does not treat ordinary numbers as card numbers', () => {
  assert.equal(masker().redact('合計 1234567890123 円'), '合計 1234567890123 円');
});

test('normalizes dynamic values for comparison only', () => {
  const m = masker();
  assert.equal(m.normalize('検索結果 3 件 (2026/10/26 10:15 現在)'), m.normalize('検索結果 3 件 (2026/10/27 09:01 現在)'));
  assert.equal(m.normalize('令和8年10月26日 伝票123'), m.normalize('令和8年11月2日 伝票999'));
  assert.notEqual(m.normalize('検索結果 3 件'), m.normalize('検索結果 4 件'));
  assert.equal(m.normalize('a\r\n  b　c '), 'a\nb c');
});

test('deep redaction covers nested structures', () => {
  const m = masker();
  const out = m.redactDeep({ a: ['x taro@example.com'], b: { c: 'password: p@ss' } });
  assert.deepEqual(out, { a: ['x <EMAIL>'], b: { c: 'password: <REDACTED>' } });
});
