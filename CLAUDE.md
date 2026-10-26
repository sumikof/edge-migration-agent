# IE-mode to Edge migration agent

The project provides a deterministic browser test harness controlled via npm scripts.
The target application repository is separate; never assume this harness contains the legacy application source.

Commands:
- `npm run doctor`
- `npm run baseline:ie`
- `npm run test:edge`
- `npm run compare`
- `npm run test:dual`

Set `SCENARIO` to choose `scenarios/<SCENARIO>.json` (default: `sample`).
Run IE mode in an interactive Windows desktop session, serially. Preserve legacy code behavior. Capture functional evidence before modifying code.
For the first pass, only validate driver boot and navigation; do not modify the business application yet.
Prioritize compatibility hot spots: `document.all`, `window.event`, `attachEvent`, ActiveX, VBScript, `showModalDialog`, legacy IE-only CSS, iframe assumptions, browser sniffing, and character encoding (e.g. Shift-JIS).
Avoid uncontrolled auto-fixes, unsafe logging, production writes, or automatic deployment.
