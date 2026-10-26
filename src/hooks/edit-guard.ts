// Claude Code PreToolUse hook for Edit/Write/MultiEdit/NotebookEdit.
// Exit code 2 blocks the tool call and shows stderr to Claude.
//
// Policy:
//  - inside this harness: CLAUDE.md and artifacts/ (evidence) are read-only.
//  - inside the configured target app: direct edits only for UTF-8 files declared in the
//    open fix attempt, with fix.allowWrite=true; Write (whole-file overwrite) is never allowed.
//    Everything else must go through `npm run fix:apply` (encoding/EOL-preserving, recorded).
//  - anywhere else: blocked.
import fs from 'node:fs';
import path from 'node:path';
import { getMigrationConfig, isWithin, resolveTargetRoot, toRel } from '../target.js';
import { openAttempt } from '../fix.js';

export type GuardInput = { tool_name?: string; tool_input?: { file_path?: string; notebook_path?: string }; cwd?: string };
export type GuardDecision = { allow: boolean; reason?: string };

export function decide(input: GuardInput, harnessRoot: string): GuardDecision {
  const tool = input.tool_name ?? '';
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return { allow: true };
  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!raw) return { allow: true };
  const file = path.resolve(input.cwd ?? harnessRoot, raw);
  const harness = fs.realpathSync.native(harnessRoot);
  if (isWithin(file, harness)) {
    const rel = path.relative(harness, file).split(path.sep).join('/');
    if (rel.toLowerCase() === 'claude.md') return { allow: false, reason: 'CLAUDE.md is the project contract and must not be modified, deleted or overwritten.' };
    if (rel === 'artifacts' || rel.startsWith('artifacts/')) return { allow: false, reason: 'artifacts/ holds run evidence and baselines; it is written only by the npm CLI and must not be edited.' };
    return { allow: true };
  }
  let targetRoot: string;
  try { targetRoot = resolveTargetRoot(getMigrationConfig(), harness); }
  catch (e) { return { allow: false, reason: `Write outside the harness blocked: ${(e as Error).message}` }; }
  if (!isWithin(file, targetRoot)) return { allow: false, reason: `${file} is outside both the harness and the designated target application (${targetRoot}).` };
  const mc = getMigrationConfig();
  if (!mc.fix.allowWrite) return { allow: false, reason: 'fix.allowWrite is false: the target application is read-only for this session.' };
  if (tool === 'Write') return { allow: false, reason: 'Whole-file Write to the business source is not allowed. Use exact edits via "npm run fix:apply -- --edits <file>".' };
  const attempt = openAttempt();
  const rel = toRel(targetRoot, file);
  const declared = attempt?.files.find((f) => f.rel === rel);
  if (!attempt || !declared || !['open', 'applied'].includes(attempt.status)) {
    return { allow: false, reason: `${rel} is not declared in an open fix attempt. Start one with "npm run fix:begin -- --findings <ids> --files ${rel} --scenario <name> --reason <text>".` };
  }
  if (declared.encoding !== 'utf-8') {
    return { allow: false, reason: `${rel} is ${declared.encoding}; direct edits could corrupt it. Use "npm run fix:apply -- --edits <file>" which preserves encoding and line endings.` };
  }
  return { allow: true };
}
