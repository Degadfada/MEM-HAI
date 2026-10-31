import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { buildVerifiedBrief } from "../src/verify.ts";

// The whole story: Claude Code works, human steers, switch to Copilot, Copilot works, switch to Codex.
test("end to end: two handoffs, memory carries forward, rules survive, undone work stays gone", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "e2e-"));
  const lp = join(cwd, ".handoff", "ledger.jsonl");
  const cli = (...a: string[]) => spawnSync("node", [resolve("src/cli.ts"), ...a, "--file", lp], { encoding: "utf8" });
  const hook = (payload: object) => spawnSync("node", [resolve("hooks/claude-code-hook.mjs")], { input: JSON.stringify({ cwd, ...payload }), env: { ...process.env, HANDOFF_CORE: resolve("dist") } });

  cli("append", "--actor-kind", "human", "--actor", "ida", "--action", "constraint", "--summary", "Never deploy on Fridays");
  cli("append", "--actor-kind", "human", "--actor", "ida", "--action", "ai.switch", "--ai", "claude-code", "--summary", "start");
  cli("append", "--actor-kind", "human", "--actor", "ida", "--action", "decision", "--target", "db", "--summary", "SQLite for now, Postgres later");
  for (let i = 0; i < 25; i++) hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(cwd, `src/m${i % 5}.ts`) } });
  hook({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" });
  hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push --force" } });
  const bad = cli("append", "--actor-kind", "ai", "--actor", "claude-code", "--action", "decision", "--target", "orm", "--summary", "Adopt Prisma", "--ai", "claude-code").stdout.trim();
  cli("reverse", "--id", bad, "--actor-kind", "human", "--actor", "ida", "--summary", "no Prisma");

  // handoff 1: Claude Code -> Copilot (CLI path)
  const r1 = cli("brief", "--to", "copilot", "--out", join(cwd, "CLAUDE.md"));
  assert.match(r1.stderr, /verified/);
  let md = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
  assert.match(md, /Never deploy on Fridays/);
  assert.match(md, /SQLite for now/);
  assert.doesNotMatch(md, /Prisma/);
  assert.match(md, /from claude-code/);

  // Copilot works (via the ledger API), human records a new decision, then handoff 2 to Codex
  const l = new Ledger(lp);
  l.append({ actor: { kind: "ai", name: "copilot" }, aiInUse: "copilot", action: "file.edit", target: "src/new.ts", approval: { status: "approved", by: "ida" } });
  l.append({ actor: { kind: "human", name: "ida" }, action: "decision", target: "db", summary: "Postgres now, SQLite dropped" });
  const t = await buildVerifiedBrief(l, "codex", "agents-md");
  assert.equal(t.report.pass, true);
  assert.match(t.brief.text, /Postgres now/);
  assert.match(t.brief.text, /src\/new\.ts/);
  assert.match(t.brief.text, /Never deploy on Fridays/);
  assert.doesNotMatch(t.brief.text, /SQLite for now/, "superseded decision must not linger");
  assert.match(t.brief.text, /claude-code → copilot/);
  assert.equal(Ledger.verify(lp).ok, true);
});
