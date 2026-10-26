# IE mode -> Chromium Edge migration harness (Windows)

Evidence-driven migration agent: a deterministic TypeScript CLI (Selenium + IEDriverServer for Edge IE mode,
Playwright `channel: 'msedge'` for Chromium Edge) records current behavior, analyzes IE-only code, applies
guarded minimal fixes to an **external** business application, runs regression comparisons and reports.
Claude Code (`.claude/agents/ie-edge-migrator.md`) orchestrates the cycle and makes every code-change decision.

> 日本語概要: 現行動作の記録（IEモード）→ 非互換コード解析 → 証拠に基づく最小修正（Claude Code）→ Edge回帰テスト
> → 差分分類（機能不一致／表示差異／環境エラー）→ 再修正、を npm コマンドと専用エージェントで回す基盤です。
> ブラウザ操作・比較・解析・ファイル編集はすべて決定的な CLI が行い、判断と実装方針は Claude Code が担います。

It is still not an unattended auto-migration system: fixes are bounded by budgets and stop conditions, and a human
reviews and commits every change to the business application.

## Preconditions
- Windows 10/11 with installed Microsoft Edge and IE-mode capability, native desktop session (not WSL for IEDriver).
- Node.js 22+ and npm; Git for Windows recommended for Claude Code (and required in the target repo for fixes).
- A test environment with accessible legacy (IE) and migrated (Edge) endpoints.
- Administrator-approved IE security / Protected Mode / zoom / site-list configuration. Do not disable corporate controls merely to run tests.
- Claude Code authentication; code sending to an external model must follow organization policy.

## Install (reproducible)
```powershell
npm ci                 # exact versions from package-lock.json
npm run doctor
npm run validate
```
Claude Code (npm alternative, but deprecated upstream as of Oct 2026):
```powershell
npm install -g @anthropic-ai/claude-code
```
If `iedriver` fails to install or a newer approved binary is required, obtain `IEDriverServer.exe` from Selenium's official release, verify provenance/checksum, and set `IE_DRIVER_PATH` to the full path.
WSL and Docker are not required (and cannot run IE mode).

## Architecture

| Module | Role |
|---|---|
| `src/core.ts` | Config/scenario loading with schema validation (`src/schema.ts`, `src/schemas.ts`), run ids, scenario hashes, origin-safe navigation, `${env:VAR}` secrets, production URL guard |
| `src/runner.ts` | Common step engine for both browsers (retries, timeouts, dialogs, windows, frames, captures, engine verification, error taxonomy, redaction, immutable run directories) |
| `src/ie.ts` | **Legacy Browser Agent**: `SeleniumIEAdapter` (IEDriverServer + Edge IE mode), interactive-session check, serial lock, doctor diagnostics on launch failure |
| `src/edge.ts` | **Modern Browser Agent**: `PlaywrightAdapter` (`channel: 'msedge'`), console/page/network errors, popups, armed dialogs, mutating-request blocking |
| `src/page-scripts.ts` | ES3-safe in-page scripts (engine info incl. `document.documentMode`, canonical DOM snapshot, form state, `window.onerror` hook) that run identically in IE document modes 5-11 and Chromium |
| `src/analyzer.ts`, `src/analyzer-rules.ts`, `src/source-text.ts` | **Migration Analyzer**: JS/JSP/HTML/CSS (+HTC/VBS), context-aware (code vs comment/string/markup), encoding-aware (UTF-8/BOM, CP932/Shift_JIS, EUC-JP), read-only |
| `src/fix.ts` | **Migration Fix Agent** support: evidence-gated attempts, scope checks, exact encoding/EOL-preserving edits, before/after diffs, per-attempt tests, budgets and stop conditions, byte-for-byte restore |
| `src/compare.ts`, `src/report.ts`, `src/baseline.ts` | **Regression Test Agent**: baseline locking + integrity, functional-first comparison, HTML/JSON/JUnit reports, migration completion verdict |
| `src/doctor.ts` | Environment diagnosis (Node, interactive session, msedge, IEDriver, Protected Mode zones, zoom, Edge IE-mode policies, URLs, scenarios, baseline integrity, target directory) |
| `src/hooks/edit-guard*.ts` | Claude Code PreToolUse hook: CLAUDE.md and `artifacts/` are read-only; target files editable only inside an open fix attempt |

Harness and business application are separate: the application lives in the directory named by
`config/migration.json` -> `targetApp.sourceRoot` (absolute path, outside this repo). If it is empty, `analyze` and
all `fix:*` commands refuse to run. Directories inside/containing the harness, home, temp and system directories are rejected.

## Configure
1. `config/targets.json`: `ieBaseUrl`, `edgeBaseUrl`, optional `edgeExecutablePath`. Optional sections (`retries`, `ie`,
   `edge`, `compare`, `masking`, `safety`) are documented with defaults in `config/targets.example.json`. Both endpoints can be the same URL only when you have verified that the IE driver forces IE mode and Playwright Edge loads Chromium content under your enterprise policy.
2. `config/migration.json`: the external target (`sourceRoot`, `include`/`exclude` globs = analysis scope, encodings) and
   fix permissions (`allowWrite` default **false**, `writableGlobs`, budgets, `verifyScenarios`). See `config/migration.example.json`.
3. Optional `config/waivers.json` (see example): approved exceptions for findings that intentionally stay (e.g. ActiveX pages kept in IE mode).
4. Scenarios: `scenarios/<name>.json`. `smoke` is the first-pass scenario (boot + navigation). See `scenarios/examples/order-search.json` for a full example.

Configuration files are schema-validated (`npm run validate`); unknown keys and wrong types are reported with their JSON path.

### Scenario steps
Original starter steps keep working unchanged: `navigate`, `waitVisible`, `click`, `fill`, `select`, `assertTextContains`, `captureText`, `screenshot`, `frame` (CSS of one iframe), `optional`.

| Group | Steps |
|---|---|
| Wait | `waitVisible`, `waitHidden`, `waitText` (`text`), `waitUrl` (`urlContains`), `wait` (`ms` <= 10000, avoid) |
| Input | `click`, `fill`, `select` (`value` / `label` / `index`), `check`, `uncheck`, `press` (`value`: `Enter`, `Tab`, ...) |
| Assert | `assertTextContains`, `assertTextEquals`, `assertValue`, `assertChecked`, `assertUrlContains`, `assertVisible`, `assertNotVisible` |
| Capture | `captureText`, `captureValue`, `captureAttribute`, `captureUrl`, `captureFormState`, `captureDom` |
| Windows/dialogs | `switchWindow` (`urlContains` / `titleContains` / `index`), `closeWindow`, `dialog` (`action`, `text`, `promptText`, `key`) placed right after the step that opens the dialog |

Locators: `selector` (CSS) or `xpath`. `frame` is a CSS/`xpath=` locator or an array for nested iframes/framesets (outermost first).
Common options: `optional`, `timeoutMs`, `retries` (default retries only for idempotent steps; never for `click`), `category`
(`business` / `validation` / `display`) to drive comparison, `secret: true` and `${env:NAME}` for credentials, `mask` (Edge screenshot masking).
Navigation accepts relative same-origin paths only. Screenshots are viewport only.

## Run (interactive Windows terminal)
```powershell
npm run smoke:ie                 # first pass: driver boot + navigation + engine check (no code changes yet)
npm run smoke:edge
npm run baseline:ie              # record current IE-mode behavior (SCENARIO or --scenario)
npm run baseline:lock            # promote the latest passed IE run to the immutable baseline
npm run test:edge
npm run compare
# or execute sequentially (never parallel):
npm run test:dual
npm run analyze                  # IE incompatibility analysis of the external target (read-only)
npm run report                   # aggregate HTML/JSON/JUnit report + completion verdict
```
For another scenario:
```powershell
$env:SCENARIO='account-search'
npm run test:dual
# or
npm run test:dual -- --scenario account-search
```
Exit codes: `0` pass, `1` functional failure / mismatch / refused, `2` usage or configuration error, `3` environment error.

Artifacts (excluded from Git):
- `artifacts/ie|edge/<scenario>/<runId>/result.json` (+ screenshots, `dom/*.txt`); `latest.json` points at the newest run. Each run has a run id, scenario hash and (Edge) the baseline id it was recorded against.
- `artifacts/baselines/<scenario>.json`: locked baseline with sha256 of every file; run files are made read-only; replacements are kept in `<scenario>.history.jsonl`.
- `artifacts/compare/<scenario>/<compareId>/report.json|report.html|junit.xml` (+ `diff-*.png`).
- `artifacts/analysis/<analysisId>/findings.json|summary.md`.
- `artifacts/fixes/<attemptId>/` (attempt.json, backup, pre/post diffs, edits) and `artifacts/report/<reportId>/`.

CI should run unit/Edge tests; schedule IE tests only on a dedicated interactive Windows agent.

### Comparison semantics
- **Functional mismatch** (fails): step failed/not reached in Edge, business capture or validation message differs, form state, dialog sequence, navigation sequence, uncaught page errors in Edge (`compare.failOnPageErrors`).
- **Display difference** (passes unless `compare.visualGate`): DOM snapshot (`captureDom`, default category `display`) and screenshot pixel differences.
- **Environment error**: engine not verified (IE run not rendered by Trident / Edge run not Chromium Edge), launch or URL failures, stale or tampered baseline, Edge run recorded against another baseline, scenario changed since the baseline.
- **Warnings**: console errors, HTTP errors, blocked mutating requests, optional steps skipped.
Dynamic values (dates incl. Japanese era, times, UUIDs, session ids, configured `masking.normalize` rules) are normalized before comparison; secrets and PII (`masking.redact`, e-mail, phone, card numbers, credentials, `${env:...}` values) are redacted before anything is written.

### Analyzer
Detects `document.all`, `element.all`, `window.event`, `event.keyCode` assignment, `attachEvent/detachEvent`, `fireEvent`,
IE-only events, `new ActiveXObject` (by ProgID), `<object classid>`, `showModalDialog`/`dialogArguments`, VBScript,
IE CSS (`expression()`, `behavior`, filters, `ime-mode`, hacks), conditional comments, `X-UA-Compatible`, `document.documentMode`,
`@cc_on`, user-agent sniffing, non-standard DOM APIs, `document.domain`, cross-frame access and charset problems.
Each finding has id, file, line/column, issue, impact scope (enclosing function, pages that include the file), recommended
fix, priority P1-P4 and a classification: `compat-issue`, `deprecated-works`, `feature-detected` or `text-only`
(comment/string/markup text = simple string match). Narrow the scope with `npm run analyze -- --scope "web/order/**" --rules attach-event,document-all`.
The analyzer never writes into the target and never performs replacements.

## Fix workflow (Claude Code decides, CLI enforces)
```powershell
npm run fix:begin   -- --scenario order-search --findings F-1a2b3c4d5e --files web/js/common.js --reason "attachEvent has no fallback; use addEventListener"
npm run fix:apply   -- --edits work\edits.json         # [{"file","findingId","oldText","newText"}]
npm run fix:verify                                   # scope + encoding + BOM + EOL checks, post.diff
npm run fix:test                                     # Edge run + comparison for the attempt (and fix.verifyScenarios)
npm run fix:restore                                  # undo the last attempt byte-for-byte (only if untouched since)
npm run fix:status
```
Gates: target configured; `fix.allowWrite: true`; files within `fix.writableGlobs`; a passed, engine-verified IE baseline
for the scenario (first pass done); evidence (analysis finding ids or a functional-mismatch comparison); clean files in the
target Git repo (existing changes are never discarded); lossless encoding. Edits must match exactly once (no bulk
replacement) and are re-encoded in the file's encoding and line endings. Stop conditions: `maxAttemptsPerFinding`,
`maxTotalAttempts`, the same failure signature twice (no progress), environment errors, regressions in other scenarios,
undeclared changes. The CLI never commits, pushes or deploys.

## Claude Code
```powershell
claude --agent ie-edge-migrator
```
Ask it to analyze the configured application directory and implement a *single* migration/verification cycle.
- `.claude/agents/ie-edge-migrator.md`: orchestrator (8 phases: survey, IE baseline, incompatibilities, impact + fix, Playwright regression, diff analysis, re-fix, completion report).
- `.claude/agents/ie-compat-analyst.md`, `.claude/agents/regression-diff-analyst.md`: read-only helpers for investigation and root-cause analysis.
- `.claude/skills/migration-cycle`, `.claude/skills/ie-compat-fix-patterns`: procedure and minimal fix patterns.
- `.claude/settings.json`: denies edits to `CLAUDE.md` and `artifacts/`, and runs the edit-guard hook for Edit/Write (a hook that times out does not block; `fix:verify` still detects out-of-scope changes).
The CLI never launches Claude Code, so there is no recursive agent loop.

## Tests
```powershell
npm run typecheck
npm run test:unit          # schema, masking, runner (mock browsers), Selenium adapter (fake WebDriver), analyzer, compare/report, fix workflow, hook
npm run test:integration   # real Playwright against local fixture pages (Edge on Windows; local Chromium elsewhere; skipped if none)
```
Result classes: mock-based tests never count as Windows verification; `npm run report` labels each scenario
`verified-on-windows`, `mock-only` or `not-run` from the IE baseline run metadata.

## Important limitations
- The IE and Edge window layouts can differ even at the same requested size. Dimensional mismatches are flagged instead of resized away.
- Pixel tolerance is just a signal. Passing an image threshold is NOT proof of equivalent business behavior. Add real assertions and DB/API verification for each business scenario.
- The harness does not decide code changes by itself; Claude Code works with the target source repo after approval, through guarded fix attempts.
- IEDriver/IE mode is interactive and policy-dependent. It may fail on locked desktops, services, or headless CI runners.
- IE mode exposes no console or network events over WebDriver; script errors are collected best effort via `window.onerror`. Mutating requests can only be blocked in Edge (Playwright); point IE runs at disposable test data.
- Screenshots, DOM snippets and test input values can contain confidential data. Do not upload or commit them. Element masking in screenshots works only in Edge.
- Do not run `iedriver` binary supplied by an unknown npm mirror or unverified source; `iedriver@4.0.0` is an older community wrapper (its install-time dependencies report `npm audit` advisories).
- Legacy JS incompatibilities include `document.all`, `window.event`, ActiveX, VBScript, `showModalDialog`, `attachEvent`, and legacy browser-specific behavior; migrations must be reviewed against actual application behavior.

## References
- https://learn.microsoft.com/en-us/microsoft-edge/webdriver/ie-mode
- https://learn.microsoft.com/en-us/microsoft-edge/playwright/
- https://www.selenium.dev/documentation/ie_driver_server/
- https://docs.anthropic.com/en/docs/claude-code/overview
