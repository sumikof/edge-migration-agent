# IE mode -> Chromium Edge migration harness (Windows)

**MVP / scaffold**, not a production-ready auto-migration system.

## Preconditions
- Windows 10/11 with installed Microsoft Edge and IE-mode capability, native desktop session (not WSL for IEDriver).
- Node.js 22+ and npm; Git for Windows recommended for Claude Code.
- A test environment with accessible legacy (IE) and migrated (Edge) endpoints.
- Administrator-approved IE security / Protected Mode / zoom / site-list configuration. Do not disable corporate controls merely to run tests.
- Claude Code authentication; code sending to an external model must follow organization policy.

## Install
```powershell
npm install
npm run doctor
```
Claude Code (npm alternative, but deprecated upstream as of Oct 2026):
```powershell
npm install -g @anthropic-ai/claude-code
```
If `iedriver` fails to install or a newer approved binary is required, obtain `IEDriverServer.exe` from Selenium's official release, verify provenance/checksum, and set `IE_DRIVER_PATH` to the full path.

## Configure
Edit `config/targets.json` and set `ieBaseUrl`, `edgeBaseUrl`, and optionally `edgeExecutablePath`. Both endpoints can be the same URL only when you have verified that the IE driver forces IE mode and Playwright Edge loads Chromium content under your enterprise policy.
Edit `scenarios/sample.json` to represent a safe, non-destructive workflow. Supported steps: `navigate`, `waitVisible`, `click`, `fill`, `select`, `assertTextContains`, `captureText`, `screenshot`. `frame` is a CSS locator for one iframe level. `optional: true` skips a failed non-critical step. Navigation accepts relative same-origin paths only. Screenshots are viewport only.

## Run (interactive Windows terminal)
```powershell
npm run baseline:ie
npm run test:edge
npm run compare
# or execute sequentially (never parallel):
npm run test:dual
```
For another scenario:
```powershell
$env:SCENARIO='account-search'
npm run test:dual
```
Artifacts appear under `artifacts/ie`, `artifacts/edge`, and `artifacts/compare` (excluded from Git). Each run has `result.json`; screenshots have optional diff PNGs. CI should run unit/Edge tests; schedule IE tests only on a dedicated interactive Windows agent.

## Claude Code
```powershell
claude --agent=ie-edge-migrator
```
Ask it to analyze an application directory explicitly and implement a *single* migration/verification cycle. The agent file is `.claude/agents/ie-edge-migrator.md`.

## Important limitations
- The IE and Edge window layouts can differ even at the same requested size. Dimensional mismatches are flagged instead of resized away.
- Pixel tolerance is just a signal. Passing an image threshold is NOT proof of equivalent business behavior. Add real assertions and DB/API verification for each business scenario.
- The starter does not perform code rewriting by itself; Claude Code works with the target source repo after approval.
- IEDriver/IE mode is interactive and policy-dependent. It may fail on locked desktops, services, or headless CI runners.
- Screenshots, DOM snippets and test input values can contain confidential data. Do not upload or commit them.
- Do not run `iedriver` binary supplied by an unknown npm mirror or unverified source; `iedriver@4.0.0` is an older community wrapper.
- Legacy JS incompatibilities include `document.all`, `window.event`, ActiveX, VBScript, `showModalDialog`, `attachEvent`, and legacy browser-specific behavior; migrations must be reviewed against actual application behavior.

## References
- https://learn.microsoft.com/en-us/microsoft-edge/webdriver/ie-mode
- https://learn.microsoft.com/en-us/microsoft-edge/playwright/
- https://www.selenium.dev/documentation/ie_driver_server/
- https://docs.anthropic.com/en/docs/claude-code/overview
