---
name: migration-cycle
description: Step-by-step procedure for one evidence-driven IE mode -> Chromium Edge migration cycle with this harness (doctor, smoke, baseline, analyze, fix attempt, regression test, diff analysis, report). Use when running or resuming a migration cycle for one business workflow.
---
# Migration cycle (one workflow or component)

All browser, comparison, analysis and target-edit actions go through `npm run ...`. Pass arguments after `--`.
Select the scenario with `--scenario <name>` (or `SCENARIO`). Run IE steps serially in an interactive Windows desktop.

## 0. Preconditions (stop and report if any fails)
```
npm run doctor            # FAIL lines are environment blockers: report them, do not work around corporate policy
npm run validate          # config + scenario schema
```
`config/migration.json` must name the external target (`targetApp.sourceRoot`). If empty: ask the user; do nothing else to the target.

## 1. First pass - driver boot and navigation only (no code changes)
```
npm run smoke:ie          # Edge IE mode via IEDriver; engine must be verified (documentMode present)
npm run smoke:edge        # Playwright channel msedge; engine must be Chromium Edge
```
Exit codes: 0 pass, 1 functional failure, 2 usage/config, 3 environment. On 3, report the printed doctor checks.

## 2. Record current behavior
1. Write/extend `scenarios/<name>.json` for ONE read-only workflow (see `scenarios/examples/`). Use `${env:VAR}` for
   credentials with `"secret": true`. Capture business values (`captureText`/`captureValue`), validation messages
   (`"category": "validation"`), form state (`captureFormState`), dialogs (`dialog` with `key`), and navigation.
2. `npm run baseline:ie -- --scenario <name>` until it passes with `engine=verified`.
3. `npm run baseline:lock -- --scenario <name>` (immutable; `--replace` only when the scenario intentionally changed).
4. `npm run test:edge -- --scenario <name>` then `npm run compare -- --scenario <name>` to see the current gap.

## 3. Find incompatibilities
`npm run analyze` (optionally `-- --scope "web/order/**"`). Read `artifacts/analysis/<id>/summary.md`.
Pick `compat-issue` findings on the failing workflow path, highest priority first. Use the `ie-compat-analyst`
subagent to confirm them against the code and map impact.

## 4. Fix attempt (minimal, evidenced)
```
npm run fix:begin -- --scenario <name> --findings F-aaa,F-bbb --files web/js/common.js --reason "<defect + evidence + intended minimal change>"
```
Write edits to a JSON file under `work/` in this harness (gitignored; never in the target), e.g.
`[{"file":"web/js/common.js","findingId":"F-aaa","oldText":"<exact current text>","newText":"<replacement>"}]`, then
```
npm run fix:apply -- --edits <edits.json>
npm run fix:verify        # scope, encoding, BOM, line endings; writes post.diff
npm run fix:test          # Edge run + compare for the attempt's scenario(s) and fix.verifyScenarios
```
`oldText` must occur exactly once (add context lines otherwise). Line endings are converted to the file's own.

## 5. On failure
- Read the compare report (`report.html`/`report.json`) or ask `regression-diff-analyst` for the root cause.
- `npm run fix:restore` (byte-for-byte), then start a corrected attempt.
- If the CLI prints `STOP (...)`: stop retrying. Report the evidence, attempts and remaining differences.
- Environment errors are not fixed by code changes.

## 6. Finish
`npm run report` -> `artifacts/report/<id>/index.html`, `summary.json`, `junit.xml`. Report: verdict and open items,
functional vs display differences, files changed with attempt ids, and everything that was not verified on real
Windows IE mode (mock-only results are never Windows verification). The user commits the target changes.
