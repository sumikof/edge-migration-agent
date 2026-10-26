export {};
// Entry point used by .claude/settings.json. Reads the hook JSON from stdin.
const projectDir = process.env.CLAUDE_PROJECT_DIR;
if (projectDir) process.chdir(projectDir);

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
let input = {};
try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* treated as empty input */ }
let decision: { allow: boolean; reason?: string };
try {
  // Imported after chdir so config paths resolve against the project directory.
  const { decide } = await import('./edit-guard.js');
  decision = decide(input, process.cwd());
} catch (e) {
  decision = { allow: false, reason: `edit-guard error: ${(e as Error).message}` };
}
if (!decision.allow) {
  process.stderr.write(`[edit-guard] ${decision.reason}\n`);
  process.exitCode = 2;
}
