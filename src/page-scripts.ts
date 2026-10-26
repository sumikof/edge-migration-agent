// In-page helper functions. They are shipped as source strings and MUST stay
// ES3-compatible: IE mode may render pages in document mode 5/7/8 where JSON,
// Array.prototype.forEach, String.prototype.trim etc. do not exist.
// Each function returns a string (serialized with the local `ser`) so both
// Selenium and Playwright transport the result identically.

const SER = `function ser(v){
  var t = typeof v, i, out, k;
  if (v === null || v === undefined) return 'null';
  if (t === 'number' || t === 'boolean') return String(v);
  if (t === 'string') {
    return '"' + v.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/\\r/g, '\\\\r').replace(/\\n/g, '\\\\n').replace(/\\t/g, '\\\\t').replace(/[\\u0000-\\u001f]/g, ' ') + '"';
  }
  if (Object.prototype.toString.call(v) === '[object Array]') {
    out = [];
    for (i = 0; i < v.length; i++) out.push(ser(v[i]));
    return '[' + out.join(',') + ']';
  }
  out = [];
  for (k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) out.push(ser(k) + ':' + ser(v[k])); }
  return '{' + out.join(',') + '}';
}`;

/** fn(el, arg) - el is unused. Describes the rendering engine of the top document. */
export const ENGINE_INFO = `function(el, arg){
  ${SER}
  var d = document, n = navigator, r = {}, brands = [], i, ua = n.userAgentData;
  r.documentMode = (typeof d.documentMode === 'number') ? d.documentMode : null;
  r.userAgent = n.userAgent;
  r.compatMode = d.compatMode || '';
  r.hasActiveX = (typeof window.ActiveXObject !== 'undefined') || ('ActiveXObject' in window);
  r.documentAllType = typeof d.all;
  r.charset = d.charset || d.characterSet || '';
  if (ua && ua.brands) { for (i = 0; i < ua.brands.length; i++) brands.push(ua.brands[i].brand); }
  r.brands = brands;
  r.url = String(location.href);
  r.title = d.title;
  return ser(r);
}`;

/** fn(el, ignoreAttrs[]) - canonical, engine-neutral text rendering of a DOM subtree. */
export const DOM_SNAPSHOT = `function(el, arg){
  var lines = [], count = 0, LIMIT = 5000, ignore = {}, i;
  var defaults = ['style', 'sizcache', 'sizset', 'uniqueid'];
  for (i = 0; i < defaults.length; i++) ignore[defaults[i]] = true;
  if (arg) { for (i = 0; i < arg.length; i++) ignore[String(arg[i]).toLowerCase()] = true; }
  function clean(s){ return String(s).replace(/[\\s\\u00a0\\u3000]+/g, ' ').replace(/^ +| +$/g, ''); }
  function attrs(node){
    var list = [], a, name, j, tag = node.nodeName.toLowerCase();
    for (j = 0; j < node.attributes.length; j++) {
      a = node.attributes[j];
      if (a.specified === false) continue;
      name = String(a.nodeName).toLowerCase();
      if (ignore[name] || /^jquery\\d+/.test(name)) continue;
      if (name === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) continue;
      list.push(name + '="' + clean(a.nodeValue === null ? '' : a.nodeValue) + '"');
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      list.push('value:="' + clean(node.value === undefined ? '' : node.value) + '"');
      if (node.type === 'checkbox' || node.type === 'radio') list.push('checked:=' + (node.checked ? 'true' : 'false'));
      if (node.disabled) list.push('disabled:=true');
    }
    if (tag === 'option' && node.selected) list.push('selected:=true');
    list.sort();
    return list.length ? ' ' + list.join(' ') : '';
  }
  function walk(node, depth){
    var c, pad = '', j, tag, txt;
    if (++count > LIMIT) return;
    for (j = 0; j < depth; j++) pad += '  ';
    if (node.nodeType === 3) {
      txt = clean(node.nodeValue);
      if (txt) lines.push(pad + '#text "' + txt + '"');
      return;
    }
    if (node.nodeType !== 1) return;
    tag = node.nodeName.toLowerCase();
    if (tag === '!' || tag === '#comment') return;
    lines.push(pad + '<' + tag + attrs(node) + '>');
    if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'frame' || tag === 'object') return;
    for (c = node.firstChild; c; c = c.nextSibling) walk(c, depth + 1);
  }
  walk(el, 0);
  if (count > LIMIT) lines.push('#truncated after ' + LIMIT + ' nodes');
  return lines.join('\\n');
}`;

/** fn(el) - input state of all form controls inside el (or el itself). */
export const FORM_STATE = `function(el, arg){
  ${SER}
  var out = [], tags = ['input', 'select', 'textarea'], i, j, list, n, item, opts, sel;
  function push(n){
    var type = String(n.type || n.nodeName).toLowerCase();
    item = { tag: n.nodeName.toLowerCase(), type: type, name: n.name || n.id || '', disabled: !!n.disabled, readOnly: !!n.readOnly };
    if (type === 'password') item.value = n.value ? '<password>' : '';
    else if (type === 'checkbox' || type === 'radio') { item.checked = !!n.checked; item.value = n.value; }
    else if (n.nodeName.toLowerCase() === 'select') {
      sel = []; opts = n.options;
      for (j = 0; j < opts.length; j++) { if (opts[j].selected) sel.push(opts[j].value + '|' + String(opts[j].text).replace(/^\\s+|\\s+$/g, '')); }
      item.selected = sel;
    } else item.value = n.value;
    out.push(item);
  }
  var own = el.nodeName.toLowerCase();
  if (own === 'input' || own === 'select' || own === 'textarea') push(el);
  for (i = 0; i < tags.length; i++) {
    list = el.getElementsByTagName(tags[i]);
    for (j = 0; j < list.length; j++) push(list[j]);
  }
  return ser(out);
}`;

/** fn() - installs a window.onerror collector (idempotent) and drains collected errors. */
export const ERROR_DRAIN = `function(el, arg){
  ${SER}
  var errs = window.__harnessErrors || [], prev;
  if (!window.__harnessErrors) {
    window.__harnessErrors = [];
    prev = window.onerror;
    window.onerror = function(m, u, l){
      try { window.__harnessErrors.push(String(m) + ' @' + u + ':' + l); } catch (e) {}
      if (prev) return prev.apply(this, arguments);
      return false;
    };
    return '[]';
  }
  window.__harnessErrors = [];
  return ser(errs);
}`;

export type EngineInfo = {
  documentMode: number | null; userAgent: string; compatMode: string; hasActiveX: boolean;
  documentAllType: string; charset: string; brands: string[]; url: string; title: string;
};
