// Rule catalog for IE -> Chromium Edge incompatibilities.
// Behavior notes reflect Chromium Edge in standards mode (not IE mode).

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Classification =
  | 'compat-issue'      // executed code that fails or behaves differently in Chromium
  | 'deprecated-works'  // non-standard but still supported by Chromium; modernize opportunistically
  | 'feature-detected'  // guarded check / fallback path exists; verify the non-IE branch
  | 'text-only';        // appears only in a comment, string or markup text (simple string match)
export type Lang = 'js' | 'css' | 'markup' | 'vbscript';
export type Context = 'code' | 'comment' | 'string' | 'markup' | 'server';
export type Category =
  | 'document-all' | 'window-event' | 'attach-event' | 'activex' | 'modal-dialog' | 'vbscript' | 'ie-css'
  | 'browser-sniffing' | 'nonstandard-dom' | 'iframe-access' | 'ie-events' | 'encoding' | 'document-mode';

export type MatchCtx = {
  match: RegExpExecArray;
  /** Column of the match inside codeLine. */
  col: number;
  /** Line text with comments and strings blanked (JS/CSS regions); raw for markup. */
  codeLine: string;
  /** Code text of up to 4 preceding and following lines. */
  around: string;
  /** Raw text (including strings/comments) of the same window. */
  rawAround: string;
  fileKind: Lang;
  context: Context;
  lang: Lang;
};
export type Verdict = { classification?: Classification; severity?: Severity; note?: string; recommendation?: string; skip?: boolean };

export type Rule = {
  id: string;
  category: Category;
  title: string;
  langs: Lang[];
  pattern: RegExp;
  severity: Severity;
  impact: string;
  recommendation: string;
  /** Match even inside comments (conditional comments, @cc_on). */
  anyContext?: boolean;
  /** Report only the first match per file. */
  oncePerFile?: boolean;
  classify?: (m: MatchCtx) => Verdict;
};

const after = (m: MatchCtx) => m.codeLine.slice(m.col + m.match[0].length);
const before = (m: MatchCtx) => m.codeLine.slice(0, m.col);

/** The token is used as a condition (if/ternary/typeof/&&/||/!) rather than called/dereferenced. */
function isConditionUse(m: MatchCtx): boolean {
  const b = before(m), a = after(m);
  if (/typeof\s*\(?\s*$/.test(b)) return true;
  if (/\bin\s*$/.test(b)) return true;
  if (/^\s*(\)|\?|&&|\|\||==|!=|;|,)/.test(a) && /(if\s*\(|\?|&&|\|\||!|\(|=)\s*[\w.$]*$/.test(b)) return true;
  return false;
}

const IE_ONLY_EVENTS = 'propertychange|beforeactivate|activate|beforedeactivate|deactivate|beforeeditfocus|filterchange|resizestart|resizeend|movestart|moveend|controlselect|layoutcomplete|help|losecapture|dataavailable|datasetchanged|rowenter|rowexit';

export const RULES: Rule[] = [
  // ---- document.all ------------------------------------------------------
  {
    id: 'document-all', category: 'document-all', title: 'document.all usage', langs: ['js'],
    pattern: /\bdocument\.all\b/g, severity: 'medium',
    impact: 'Chromium supports document.all lookups but the collection is falsy (typeof === "undefined"); IE-only branches guarded by it are skipped.',
    recommendation: 'Replace lookups with document.getElementById / querySelector(All). Replace `if (document.all)` detection with feature detection of the API actually used.',
    classify: (m) => {
      const a = after(m);
      if (/^\s*\.\s*tags\s*\(/.test(a)) return { classification: 'compat-issue', severity: 'high', note: 'document.all.tags() is not supported in Chromium.', recommendation: 'Use document.getElementsByTagName().' };
      if (isConditionUse(m)) return { classification: 'compat-issue', severity: 'high', note: 'Used as a browser check: evaluates to false in Chromium, so the IE branch never runs.' };
      return { classification: 'deprecated-works', note: 'Lookup works in Chromium (HTMLAllCollection) but is non-standard.' };
    },
  },
  {
    id: 'element-all', category: 'document-all', title: 'element.all collection', langs: ['js'],
    pattern: /(?<!\bdocument)(?<=[\w\])])\.all\s*(?=[[(.])/g, severity: 'high',
    impact: 'element.all exists only in IE; it is undefined in Chromium and causes a TypeError.',
    recommendation: 'Use element.querySelectorAll / getElementsByTagName / children.',
    classify: (m) => (/^\s*\.\s*(length)\b/.test(after(m)) ? { severity: 'medium' } : {}),
  },
  // ---- window.event / IE event model --------------------------------------
  {
    id: 'window-event', category: 'window-event', title: 'Global window.event', langs: ['js'],
    pattern: /\bwindow\.event\b/g, severity: 'medium',
    impact: 'Chromium still exposes window.event but it is deprecated and undefined inside asynchronous callbacks and in handlers attached with addEventListener from other frames.',
    recommendation: 'Use the event argument passed to the handler (e = e || window.event during transition).',
    classify: (m) => (/\|\|\s*$/.test(before(m)) || /\w+\s*\|\|\s*$/.test(before(m))
      ? { classification: 'feature-detected', severity: 'low', note: 'Fallback pattern (e || window.event).' }
      : { classification: 'deprecated-works' }),
  },
  {
    id: 'event-keycode-assign', category: 'ie-events', title: 'Assignment to event.keyCode', langs: ['js'],
    pattern: /\b(?:window\.)?(?:event|e|evt|ev)\.keyCode\s*=(?!=)/g, severity: 'high',
    impact: 'IE allowed rewriting keyCode (e.g. Enter -> Tab focus movement). In Chromium keyCode is read-only; the assignment is ignored and the original key takes effect (form may submit on Enter).',
    recommendation: 'preventDefault() the key event and move focus explicitly (e.g. focus the next field) instead of rewriting keyCode.',
  },
  {
    id: 'event-srcelement', category: 'ie-events', title: 'event.srcElement / returnValue / cancelBubble', langs: ['js'],
    pattern: /\.(srcElement|returnValue|cancelBubble|fromElement|toElement)\b/g, severity: 'low',
    impact: 'Supported by Chromium for compatibility but non-standard. Note: window.returnValue (dialog result) is a separate showModalDialog issue.',
    recommendation: 'Use event.target, event.preventDefault(), event.stopPropagation(), relatedTarget.',
    classify: (m) => {
      if (/\bwindow\s*$/.test(before(m)) && m.match[1] === 'returnValue') return { skip: true };
      return { classification: 'deprecated-works' };
    },
  },
  {
    id: 'attach-event', category: 'attach-event', title: 'attachEvent / detachEvent', langs: ['js'],
    pattern: /\.(attachEvent|detachEvent)\b/g, severity: 'high',
    impact: 'attachEvent/detachEvent do not exist in Chromium: calling them throws TypeError and the handler is never registered.',
    recommendation: 'Use addEventListener/removeEventListener (event name without "on"); `this` and the event argument semantics differ - verify handlers that rely on window.event or `this` being window.',
    classify: (m) => {
      if (!/^\s*\(/.test(after(m))) return { classification: 'feature-detected', severity: 'low', note: 'Referenced without call (detection).' };
      if (/addEventListener/.test(m.around)) return { classification: 'feature-detected', severity: 'low', note: 'An addEventListener path exists nearby; verify it is taken in Chromium.' };
      return { classification: 'compat-issue' };
    },
  },
  {
    id: 'fire-event', category: 'ie-events', title: 'element.fireEvent', langs: ['js'],
    pattern: /\.fireEvent\s*\(/g, severity: 'high',
    impact: 'fireEvent is IE-only; Chromium throws TypeError.',
    recommendation: 'Use element.dispatchEvent(new Event(type, { bubbles: true })) or call the handler directly.',
  },
  {
    id: 'ie-only-events', category: 'ie-events', title: 'IE-only event handler', langs: ['js'],
    pattern: new RegExp(`\\bon(${IE_ONLY_EVENTS})\\b`, 'gi'), severity: 'high',
    impact: 'Event is never fired by Chromium; logic in the handler silently stops running.',
    recommendation: 'propertychange -> input/change event or MutationObserver; activate/deactivate -> focusin/focusout; help -> keydown F1 handler.',
  },
  {
    id: 'ie-only-event-attr', category: 'ie-events', title: 'IE-only event handler attribute', langs: ['markup'],
    pattern: new RegExp(`(?<=<[a-zA-Z][^<>]*\\s)on(${IE_ONLY_EVENTS})\\s*=`, 'gi'), severity: 'high',
    impact: 'Chromium never fires this event; the inline handler does not run.',
    recommendation: 'propertychange -> oninput/onchange; activate/deactivate -> onfocus/onblur (focusin/focusout); help -> keydown F1.',
  },
  {
    id: 'element-readystatechange', category: 'ie-events', title: 'onreadystatechange on elements', langs: ['js'],
    pattern: /\b(\w+)\.onreadystatechange\b|<(?:script|img|link|iframe|object)\b[^>]*\bonreadystatechange\s*=/gi, severity: 'medium',
    impact: 'IE fired readystatechange on script/img/link elements; Chromium only on document and XMLHttpRequest.',
    recommendation: 'Use load/error events on elements.',
    classify: (m) => (m.match[1] && /xhr|req|http|request|ajax|document/i.test(m.match[1]) ? { skip: true } : {}),
  },
  {
    id: 'script-for-event', category: 'ie-events', title: '<script for=... event=...>', langs: ['markup'],
    pattern: /<script\b[^>]*\bfor\s*=\s*["']?[\w.]+["']?[^>]*\bevent\s*=/gi, severity: 'high',
    impact: 'IE-only script binding syntax: Chromium executes the script immediately at parse time instead of on the event.',
    recommendation: 'Move the code into a function and register it with addEventListener.',
  },
  // ---- ActiveX ----------------------------------------------------------------
  {
    id: 'activex-object', category: 'activex', title: 'new ActiveXObject(...)', langs: ['js'],
    pattern: /\bnew\s+ActiveXObject\s*\(\s*(?:["']([^"']+)["'])?/g, severity: 'critical',
    impact: 'ActiveX is unavailable in Chromium: ReferenceError, and the feature backed by the COM object is lost.',
    recommendation: 'Microsoft.XMLHTTP/Msxml2.XMLHTTP -> XMLHttpRequest/fetch; Msxml2.DOMDocument -> DOMParser/XMLSerializer; FileSystemObject/WScript.Shell/Excel.Application etc. have no browser equivalent: move to server-side processing or a supported download/upload flow (business decision required).',
    classify: (m) => {
      const progId = (m.match[1] ?? '').toLowerCase();
      const nearbyStandard = /XMLHttpRequest|DOMParser/.test(m.around);
      if (/xmlhttp/.test(progId)) {
        return nearbyStandard
          ? { classification: 'feature-detected', severity: 'low', note: `${m.match[1]} with an XMLHttpRequest path nearby.` }
          : { severity: 'high', recommendation: 'Replace with new XMLHttpRequest() (same API surface for open/send/onreadystatechange).' };
      }
      if (/domdocument|xmldom/.test(progId)) return { severity: 'high', recommendation: 'Use DOMParser / XMLSerializer / document.implementation.createDocument; replace selectNodes/selectSingleNode with document.evaluate or querySelector.' };
      if (progId) return { note: `COM ProgID ${m.match[1]} - no web equivalent; requires a design decision.` };
      return {};
    },
  },
  {
    id: 'activex-detect', category: 'browser-sniffing', title: 'ActiveXObject detection', langs: ['js'],
    pattern: /\bwindow\.ActiveXObject\b|["']ActiveXObject["']\s+in\s+window|typeof\s*\(?\s*ActiveXObject\b/g, severity: 'medium',
    impact: 'Used to detect IE. False in Chromium (and window.ActiveXObject is already undefined in IE11), so IE-specific branches are skipped.',
    recommendation: 'Detect the specific capability used instead of the browser; confirm the non-IE branch is functionally equivalent.',
    classify: () => ({ classification: 'feature-detected' }),
  },
  {
    id: 'object-classid', category: 'activex', title: '<object classid=...> ActiveX control', langs: ['markup'],
    pattern: /<object\b[^>]*\bclassid\s*=\s*["']?clsid:/gi, severity: 'critical',
    impact: 'ActiveX controls are not loaded by Chromium; the embedded component (printing, file access, signing, grids...) is missing.',
    recommendation: 'Replace with a web-standard component or server-side feature; keep IE mode for this page only if no replacement exists (Enterprise Mode site list).',
  },
  // ---- Modal dialogs -----------------------------------------------------------
  {
    id: 'show-modal-dialog', category: 'modal-dialog', title: 'showModalDialog / showModelessDialog', langs: ['js'],
    pattern: /\b(showModalDialog|showModelessDialog)\b/g, severity: 'critical',
    impact: 'Removed from Chromium. Calling it throws TypeError; the synchronous return value (window.returnValue) and dialogArguments flow is lost.',
    recommendation: 'Replace with an in-page modal (e.g. <dialog>) or window.open plus a callback/postMessage; convert the caller to asynchronous continuation. Keep business validation identical.',
    classify: (m) => (!/^\s*\(/.test(after(m)) ? { classification: 'feature-detected', severity: 'medium', note: 'Referenced without call (detection or alias).' } : {}),
  },
  {
    id: 'dialog-arguments', category: 'modal-dialog', title: 'window.dialogArguments / window.returnValue', langs: ['js'],
    pattern: /\b(?:window\.)?dialogArguments\b|\bwindow\.returnValue\b/g, severity: 'high',
    impact: 'Only meaningful inside showModalDialog; undefined in Chromium so the dialog page receives no input and returns nothing.',
    recommendation: 'Pass arguments via URL/query, sessionStorage or postMessage; return results via opener callback or postMessage.',
  },
  // ---- VBScript ----------------------------------------------------------------
  {
    id: 'vbscript-block', category: 'vbscript', title: 'VBScript block', langs: ['markup'],
    pattern: /<script\b[^>]*\b(?:language|type)\s*=\s*["']?(?:text\/)?vbscript/gi, severity: 'critical',
    impact: 'Chromium does not execute VBScript; all logic in the block (validation, formatting, events) is missing.',
    recommendation: 'Port the logic to JavaScript function-by-function and cover it with scenario assertions (validation messages, computed values).',
  },
  {
    id: 'vbscript-url', category: 'vbscript', title: 'vbscript: URL / VBScript handler', langs: ['markup', 'js'],
    pattern: /vbscript:|\blanguage\s*=\s*["']?vbscript\b/gi, severity: 'critical',
    impact: 'Chromium ignores vbscript: URLs and VBScript event handlers.',
    recommendation: 'Rewrite the handler in JavaScript.',
    classify: (m) => (m.lang === 'markup' && /<script\b/i.test(m.codeLine) ? { skip: true } : {}),
  },
  {
    id: 'vbscript-file', category: 'vbscript', title: 'VBScript source', langs: ['vbscript'],
    pattern: /^\s*(?:Function|Sub|Dim|Set|MsgBox|CreateObject|Option\s+Explicit)\b/gim, severity: 'critical', oncePerFile: true,
    impact: 'VBScript file is not executed by Chromium.',
    recommendation: 'Port to JavaScript.',
    classify: (m) => (m.fileKind === 'markup' ? { skip: true } : {}),
  },
  // ---- IE-only CSS -----------------------------------------------------------
  {
    id: 'css-expression', category: 'ie-css', title: 'CSS expression()', langs: ['css'],
    pattern: /:\s*expression\s*\(/gi, severity: 'high',
    impact: 'Ignored by Chromium: dynamically computed sizes/positions/visibility fall back to defaults.',
    recommendation: 'Compute in JavaScript (resize/input events) or use calc(), flexbox, position: sticky.',
  },
  {
    id: 'css-behavior', category: 'ie-css', title: 'CSS behavior: url(*.htc)', langs: ['css'],
    pattern: /\bbehavior\s*:\s*url\s*\(/gi, severity: 'high',
    impact: 'HTML Components (.htc) are not supported; attached behaviors (formatting, input restrictions, rounded corners) disappear.',
    recommendation: 'Re-implement the .htc logic as JavaScript attached on DOMContentLoaded, or with CSS where purely visual.',
  },
  {
    id: 'css-filter', category: 'ie-css', title: 'IE filter / -ms-filter', langs: ['css'],
    pattern: /(?:-ms-filter|\bfilter)\s*:\s*["']?\s*(?:progid:|alpha\s*\()/gi, severity: 'medium',
    impact: 'Visual only: opacity/gradients/rotation defined with DirectX filters are not rendered.',
    recommendation: 'Use opacity, linear-gradient, transform. Visual difference - confirm against screenshots.',
  },
  {
    id: 'css-ime-mode', category: 'ie-css', title: 'ime-mode', langs: ['css'],
    pattern: /\bime-mode\s*:/gi, severity: 'medium',
    impact: 'Chromium ignores ime-mode: Japanese IME is no longer forced on/off for input fields (kana/number entry fields).',
    recommendation: 'Use inputmode / pattern attributes plus server-side and JavaScript validation; confirm with users that IME behavior change is acceptable.',
  },
  {
    id: 'css-cursor-hand', category: 'ie-css', title: 'cursor: hand', langs: ['css'],
    pattern: /\bcursor\s*:\s*hand\b/gi, severity: 'low',
    impact: 'Invalid in Chromium; the default cursor is shown.',
    recommendation: 'Use cursor: pointer.',
  },
  {
    id: 'css-hacks', category: 'ie-css', title: 'IE CSS hack / proprietary property', langs: ['css'],
    pattern: /(?:^|[;{\s])([*_][a-z-]+)\s*:|\bscrollbar-(?:face|arrow|track|shadow|highlight|3dlight|darkshadow|base)-color\b|\bzoom\s*:\s*1\b|\\9\s*;|\\0\/?\s*;|\bwriting-mode\s*:\s*tb-rl\b|\blayout-grid/gi, severity: 'low',
    impact: 'Ignored by Chromium; layout or colors may differ (visual).',
    recommendation: 'Remove the hack and verify layout with the standard property; treat as a visual difference.',
  },
  // ---- Markup / document mode ------------------------------------------------
  {
    id: 'conditional-comment', category: 'document-mode', title: 'IE conditional comment', langs: ['markup'],
    pattern: /<!--\[if\s+[^\]]*\]>|<!\[if\s+[^\]]*\]>/gi, severity: 'high', anyContext: true,
    impact: 'Chromium treats conditional comments as plain comments: IE-only scripts/styles inside them are not loaded and [if !IE] content is shown.',
    recommendation: 'Load required resources unconditionally (or by feature detection); verify what the IE-only block provided.',
  },
  {
    id: 'x-ua-compatible', category: 'document-mode', title: 'X-UA-Compatible / document mode', langs: ['markup'],
    pattern: /<meta\b[^>]*http-equiv\s*=\s*["']?X-UA-Compatible[^>]*>/gi, severity: 'medium',
    impact: 'Pinned document mode (e.g. IE=5/7/EmulateIE8) means the page relies on quirks/legacy layout. Chromium renders in standards or quirks mode based on DOCTYPE only.',
    recommendation: 'Check the DOCTYPE; quirks-mode layout (box model, table heights) differences appear as visual diffs.',
  },
  {
    id: 'document-mode', category: 'browser-sniffing', title: 'document.documentMode', langs: ['js'],
    pattern: /\bdocument\.documentMode\b/g, severity: 'high',
    impact: 'undefined in Chromium; branches depending on the IE document mode change behavior.',
    recommendation: 'Replace with feature detection.',
    classify: (m) => (isConditionUse(m) ? { classification: 'feature-detected', severity: 'medium' } : {}),
  },
  {
    id: 'cc-on', category: 'browser-sniffing', title: 'JScript conditional compilation (@cc_on)', langs: ['js'],
    pattern: /@cc_on|@if\s*\(\s*@_jscript|@_jscript_version/g, severity: 'high', anyContext: true,
    impact: 'Code inside /*@cc_on ... @*/ only runs in IE; in Chromium it is a comment.',
    recommendation: 'Make the code unconditional or use feature detection.',
  },
  {
    id: 'data-island', category: 'nonstandard-dom', title: 'XML data island / data binding / VML', langs: ['markup'],
    pattern: /<xml\b[^>]*\bid\s*=|\bdatasrc\s*=|\bdatafld\s*=|<v:\w+|<\?import\b|\bxmlns:v\s*=/gi, severity: 'high',
    impact: 'IE-only data binding / VML: bound values and vector graphics are not rendered.',
    recommendation: 'Render values server-side or bind with JavaScript; replace VML with SVG.',
  },
  // ---- Browser sniffing --------------------------------------------------------
  {
    id: 'ua-sniffing', category: 'browser-sniffing', title: 'User agent / appName sniffing', langs: ['js'],
    pattern: /\bnavigator\.(userAgent|appName|appVersion|browserLanguage|userLanguage|systemLanguage|cpuClass)\b/g, severity: 'high',
    impact: 'Browser detection branches take the non-IE path in Edge (appName is "Netscape"; browserLanguage/userLanguage are undefined).',
    recommendation: 'Use feature detection; use navigator.language instead of browserLanguage/userLanguage.',
    classify: (m) => {
      const prop = m.match[1];
      if (prop === 'userAgent' && !/MSIE|Trident|msie|trident|IE\b/.test(m.rawAround)) {
        return { classification: 'deprecated-works', severity: 'low', note: 'userAgent read without an IE token nearby - verify usage.' };
      }
      if (/Language$/.test(prop)) return { classification: 'compat-issue', severity: 'medium' };
      return {};
    },
  },
  // ---- Non-standard DOM --------------------------------------------------------
  {
    id: 'nonstandard-dom-removed', category: 'nonstandard-dom', title: 'IE-only DOM API', langs: ['js'],
    pattern: /\.(currentStyle|runtimeStyle|createTextRange|setCapture|releaseCapture|removeNode|replaceNode|swapNode|applyElement|mergeAttributes|uniqueID|sourceIndex|filters|parentWindow|createPopup|selectSingleNode|selectNodes|transformNode|loadXML|doScroll|componentFromPoint|clearAttributes|getExpression|setExpression)\b|\bdocument\.(selection|createStyleSheet|frames)\b|\bwindow\.(clipboardData|navigate|createPopup)\b|\bnew\s+XDomainRequest\b|\.children\.tags\s*\(|\.styleSheet\.cssText/g, severity: 'high',
    impact: 'Not implemented in Chromium: TypeError/undefined at runtime.',
    recommendation: 'currentStyle -> getComputedStyle; createTextRange/document.selection -> Selection/Range API, setSelectionRange; removeNode -> remove(); selectNodes -> document.evaluate; clipboardData -> navigator.clipboard (async, permission); window.navigate -> location.href; doScroll -> DOMContentLoaded.',
    classify: (m) => (!/^\s*\(/.test(after(m)) && isConditionUse(m) ? { classification: 'feature-detected', severity: 'low' } : {}),
  },
  {
    id: 'window-external', category: 'nonstandard-dom', title: 'window.external', langs: ['js'],
    pattern: /\bwindow\.external\.\w+/g, severity: 'medium',
    impact: 'IE host methods (AddFavorite, etc.) are no-ops or missing in Chromium.',
    recommendation: 'Remove or replace with an equivalent UI hint.',
  },
  {
    id: 'exec-command-ie', category: 'nonstandard-dom', title: 'IE-only execCommand', langs: ['js'],
    pattern: /execCommand\s*\(\s*["'](SaveAs|Print|Stop|Refresh|BrowseMode|2D-Position|LiveResize|ClearAuthenticationCache)["']/gi, severity: 'medium',
    impact: 'Command not supported by Chromium; returns false.',
    recommendation: 'SaveAs -> download link (Blob); Print -> window.print(); ClearAuthenticationCache -> server-side logout.',
  },
  // ---- iframe / cross-window access -----------------------------------------
  {
    id: 'document-domain', category: 'iframe-access', title: 'document.domain assignment', langs: ['js'],
    pattern: /\bdocument\.domain\s*=(?!=)/g, severity: 'high',
    impact: 'Chromium Edge uses origin-keyed agent clusters by default: setting document.domain no longer relaxes the same-origin policy, so cross-subdomain frame access throws SecurityError.',
    recommendation: 'Serve frames from the same origin or communicate via postMessage; Origin-Agent-Cluster: ?0 is only a temporary workaround.',
  },
  {
    id: 'cross-frame-dom', category: 'iframe-access', title: 'Cross-frame DOM access', langs: ['js'],
    pattern: /\b(?:parent|top|opener|window\.parent|window\.top|window\.opener)\.(?:frames\s*\[[^\]]+\]\.|frames\.\w+\.|\w+\.)?document\b|\b(?:parent|top|window)\.frames\s*[[(.]|\.contentWindow\.document\b/g, severity: 'medium',
    impact: 'Works only when frames are same-origin and loaded; IE allowed some access patterns (frames by name via document.frames, access before load) that fail in Chromium. Sandboxed or cross-origin frames throw SecurityError.',
    recommendation: 'Verify frame origin and load timing; wait for the frame load event; prefer postMessage for cross-origin communication. Add a scenario step with the nested frame chain.',
  },
  // ---- Encoding (file level, emitted by the analyzer) -----------------------
  {
    id: 'encoding-undeclared', category: 'encoding', title: 'Non-UTF-8 file without declared charset', langs: [],
    pattern: /$^/g, severity: 'medium',
    impact: 'Chromium decides the charset from the HTTP header / meta tag / BOM; without a declaration Japanese text may be mojibake (IE used locale-based auto-detection).',
    recommendation: 'Make the server send Content-Type with charset (e.g. Windows-31J) or add <meta charset> / pageEncoding; for scripts add charset to <script> or serve the header. Do NOT re-encode files during the migration.',
  },
  {
    id: 'encoding-mismatch', category: 'encoding', title: 'Declared charset differs from file bytes', langs: [],
    pattern: /$^/g, severity: 'high',
    impact: 'The declaration does not match the actual encoding; Chromium follows the declaration and shows mojibake.',
    recommendation: 'Correct the declaration to the real encoding (keep file bytes unchanged).',
  },
  {
    id: 'encoding-mixed-eol', category: 'encoding', title: 'Mixed line endings', langs: [],
    pattern: /$^/g, severity: 'info',
    impact: 'No browser impact; edits must preserve the existing line endings per file.',
    recommendation: 'Leave as is; the fix tool preserves the dominant line ending of each edit.',
  },
];

export const RULE_IDS = RULES.map((r) => r.id);
