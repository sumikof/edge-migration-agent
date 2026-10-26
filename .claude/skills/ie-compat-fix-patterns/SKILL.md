---
name: ie-compat-fix-patterns
description: Minimal, behavior-preserving fix patterns for IE-only code (document.all, window.event, attachEvent, ActiveX, showModalDialog, VBScript, IE CSS, browser sniffing, iframe access, IE events, Shift_JIS/charset). Use when planning or reviewing an edit for an analyzer finding.
---
# Minimal fix patterns (analyzer rule id -> change)

Principles: change only the incompatible expression; keep names, messages, order of side effects, return values and
encoding. Prefer a local compatible branch over rewriting the function. One finding (or one tightly coupled group) per attempt.

| Rule | Minimal change | Watch out |
|---|---|---|
| `document-all` (condition) | Replace the browser check with feature detection of the API used, e.g. `if (document.getElementById)` | The IE branch may contain logic missing from the other branch: merge, do not drop |
| `document-all` (lookup) | `document.all('x')` / `document.all.x` -> `document.getElementById('x')`; by name -> `document.getElementsByName('x')[0]` | IE `document.all` also matched `name`; verify the element has the id |
| `element-all` | `el.all.tags('TD')` -> `el.getElementsByTagName('td')` | Live vs static collection |
| `attach-event` | `el.attachEvent('onclick', f)` -> `el.addEventListener('click', f, false)` | Inside the handler `this` was `window` in IE and becomes `el`; handlers using `window.event` need the event argument |
| `window-event` | `function h(){ var e = window.event; ...}` -> `function h(e){ e = e || window.event; ...}` | Works in Chromium already; change only where the handler is attached via addEventListener or runs async |
| `event-keycode-assign` | Enter->Tab trick: `if (e.keyCode == 13) { e.preventDefault(); focusNext(srcEl); }` | Keep IME composition: skip when `e.isComposing` |
| `event-srcelement` | `event.srcElement` -> `(event.target || event.srcElement)` | Not required for Chromium; only touch when editing the line anyway |
| `fire-event` | `el.fireEvent('onchange')` -> `el.dispatchEvent(new Event('change', { bubbles: true }))` | IE fired handlers synchronously; dispatchEvent is also synchronous |
| `ie-only-events` / `ie-only-event-attr` | `onpropertychange` -> `oninput` (value) / `onchange`; `onactivate` -> `onfocus` | propertychange also fired on programmatic value changes: call the handler after scripted updates |
| `activex-object` XMLHTTP | `new ActiveXObject("Microsoft.XMLHTTP")` -> `new XMLHttpRequest()` | Keep synchronous/async flag and charset handling identical |
| `activex-object` DOMDocument | `loadXML` -> `new DOMParser().parseFromString(s, 'text/xml')`; `selectNodes(xp)` -> `document.evaluate` | XPath namespaces |
| `activex-object` other / `object-classid` | No browser equivalent: STOP and escalate (server-side redesign or keep page in IE mode via site list + waiver) | Never emulate file system / Excel access in the browser |
| `show-modal-dialog` | Replace with `window.open` + callback (or in-page `<dialog>`); move code after the call into the callback | Caller relied on blocking: everything after the call must run only after the dialog closes |
| `dialog-arguments` | Pass input via query/sessionStorage/`window.opener` callback; return via `opener.<callback>(value)` | Same-origin requirement |
| `vbscript-*` | Port each Sub/Function 1:1 to JavaScript; keep message texts and number/date formatting | VBScript `CInt`/`CDate`/`FormatNumber` semantics differ from JS - add scenario assertions for formatted values |
| `css-expression` | Compute in JS on load/resize, or use `calc()` | Visual only unless it hides/shows controls |
| `css-behavior` | Re-implement the .htc behavior in JS attached on load | Behaviors often restrict input (numeric only): functional |
| `css-filter` / `css-hacks` / `css-cursor-hand` | `opacity`, `linear-gradient`, `transform`, `cursor: pointer` | Visual difference only |
| `css-ime-mode` | No equivalent; `inputmode`/`pattern` + validation. Ask the business owner | Behavior change for Japanese input fields |
| `conditional-comment` | Load required scripts/styles unconditionally or behind feature detection | `[if !IE]` content now shows in Edge |
| `ua-sniffing` / `document-mode` / `cc-on` / `activex-detect` | Replace the browser test with the capability test of what the branch uses | Keep the branch that implements the business rule |
| `document-domain` | Remove only when frames are same-origin; otherwise postMessage | Needs server/origin knowledge - escalate if unsure |
| `cross-frame-dom` | Wait for frame load (`onload`) before access; use `frames['name']` via `window.frames` not `document.frames` | Add a scenario step with the frame chain |
| `nonstandard-dom-removed` | `currentStyle` -> `getComputedStyle(el)`; `removeNode(true)` -> `el.parentNode.removeChild(el)`; `createTextRange` -> `setSelectionRange` | Return value shapes differ (getComputedStyle returns resolved px) |
| `encoding-*` | Fix the declaration/header, never re-encode the file | Keep Windows-31J for Japanese legacy pages |

## Encoding and line endings
- Target files may be CP932 (Shift_JIS) with CRLF. Use `npm run fix:apply`; it decodes losslessly, replaces exactly one
  occurrence per edit, converts your newText to the file's line endings and refuses characters that CP932 cannot represent
  (e.g. emoji, some symbols). Write Japanese in newText normally (the edits JSON is UTF-8).
- Do not add a BOM, do not normalize whitespace, do not reformat.
