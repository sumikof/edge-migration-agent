import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { DOM_SNAPSHOT, ENGINE_INFO, ERROR_DRAIN, FORM_STATE } from '../src/page-scripts.ts';

// These scripts run inside IE document modes 5-11; they must avoid ES5+ syntax and APIs.
const scripts = { DOM_SNAPSHOT, ENGINE_INFO, ERROR_DRAIN, FORM_STATE };

test('in-page scripts avoid ES5+/ES6 syntax and APIs unavailable in old IE document modes', () => {
  const forbidden = [/=>/, /\blet\s/, /\bconst\s/, /`/, /\.forEach\(/, /\.map\(/, /\.filter\(/, /\.trim\(/, /\bJSON\./, /Object\.keys/, /\.indexOf\(/, /\.\.\./, /\bclass\s/];
  for (const [name, src] of Object.entries(scripts)) {
    for (const re of forbidden) assert.ok(!re.test(src), `${name} uses ${re}`);
    assert.doesNotThrow(() => new vm.Script(`(${src})`), `${name} must parse`);
  }
});

test('ENGINE_INFO serializer works without JSON (IE quirks mode)', () => {
  const ctx = vm.createContext({
    document: { documentMode: 5, compatMode: 'BackCompat', all: {}, charset: 'shift_jis', title: 't"x' },
    navigator: { userAgent: 'Mozilla/4.0 (compatible; MSIE 7.0; Trident/7.0)' },
    location: { href: 'http://x/a' },
    window: {},
  });
  ctx.window.ActiveXObject = function () {};
  const out = vm.runInContext(`delete this.JSON; (${ENGINE_INFO})(null, null)`, ctx);
  assert.deepEqual(JSON.parse(out), { documentMode: 5, userAgent: 'Mozilla/4.0 (compatible; MSIE 7.0; Trident/7.0)', compatMode: 'BackCompat', hasActiveX: true, documentAllType: 'object', charset: 'shift_jis', brands: [], url: 'http://x/a', title: 't"x' });
});
