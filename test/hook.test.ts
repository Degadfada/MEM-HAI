import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ledger } from "../src/ledger.ts";

const HOOK = resolve("hooks/claude-code-hook.mjs");
const run = (cwd: string, payload: unknown, raw?: string) =>
  spawnSync("node", [HOOK], { input: raw ?? JSON.stringify(payload), encoding: "utf8", env: { ...process.env, HANDOFF_CORE: resolve("dist") }, cwd });

test("hook records edits and commands as AI actions; permission prompt => human approval", () => {
  execBuild();
  const cwd = mkdtempSync(join(tmpdir(), "hook-"));
  const lp = join(cwd, ".handoff", "ledger.jsonl");
  let r = run(cwd, { hook_event_name: "PostToolUse", cwd, tool_name: "Edit", tool_input: { file_path: join(cwd, "src/a.ts") } });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  run(cwd, { hook_event_name: "Notification", cwd, message: "Claude needs your permission to use Bash" });
  run(cwd, { hook_event_name: "PostToolUse", cwd, tool_name: "Bash", tool_input: { command: "npm publish", description: "publish" } });
  run(cwd, { hook_event_name: "PostToolUse", cwd, tool_name: "Bash", tool_input: { command: "ls" } });
  run(cwd, { hook_event_name: "PostToolUse", cwd, tool_name: "Read", tool_input: { file_path: "x" } }); // reads are not logged
  const ev = new Ledger(lp).all();
  assert.equal(ev.length, 3);
  assert.deepEqual([ev[0]!.action, ev[0]!.target, ev[0]!.actor.kind, ev[0]!.aiInUse], ["file.edit", "src/a.ts", "ai", "claude-code"]);
  assert.equal(ev[0]!.approval.status, "not_required");
  assert.equal(ev[1]!.approval.status, "approved");
  assert.equal(ev[1]!.approval.by, "human");
  assert.equal(ev[2]!.approval.status, "not_required"); // marker consumed by the first command only
  assert.ok(!existsSync(join(cwd, ".handoff", ".pending-permission")));
  assert.equal(Ledger.verify(lp).ok, true);
});

test("hook never fails or prints, even on garbage input", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hook-"));
  const r = run(cwd, null, "not json at all");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("hook redacts secrets in commands", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hook-"));
  run(cwd, { hook_event_name: "PostToolUse", cwd, tool_name: "Bash", tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' x" } });
  const e = new Ledger(join(cwd, ".handoff", "ledger.jsonl")).all()[0]!;
  assert.match(e.target!, /REDACTED/);
});

import { execSync } from "node:child_process";
function execBuild() { if (!existsSync(resolve("dist/ledger.js"))) execSync("npx tsc -p .", { stdio: "inherit" }); }

import { addGuardrail } from "../src/guardrails.ts";

test("PreToolUse: a block-level guardrail denies the tool call with Claude Code's deny JSON, and logs the attempt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hook-"));
  const lp = join(cwd, ".handoff", "ledger.jsonl");
  const l = new Ledger(lp);
  addGuardrail(l, { kind: "human", name: "me" }, "block", "Never push --force", { kind: "command", pattern: "push\\s+.*--force" });
  addGuardrail(l, { kind: "human", name: "me" }, "block", "Keep out of env files", { kind: "path", pattern: "**/.env*" });
  addGuardrail(l, { kind: "human", name: "me" }, "advise", "Small commits please", { kind: "command", pattern: "commit -a" });

  const bad = run(cwd, { hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command: "git push origin main --force" } });
  assert.equal(bad.status, 0);
  const out = JSON.parse(bad.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Never push --force/);

  const env = run(cwd, { hook_event_name: "PreToolUse", cwd, tool_name: "Edit", tool_input: { file_path: join(cwd, "api/.env.local") } });
  assert.equal(JSON.parse(env.stdout).hookSpecificOutput.permissionDecision, "deny");

  const fine = run(cwd, { hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command: "git push origin main" } });
  assert.equal(fine.stdout, "", "allowed calls print nothing");
  const advise = run(cwd, { hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command: "git commit -a -m x" } });
  assert.equal(advise.stdout, "", "advise rules never block");
  const read = run(cwd, { hook_event_name: "PreToolUse", cwd, tool_name: "Read", tool_input: { file_path: ".env" } });
  assert.equal(read.stdout, "", "reads are not gated");

  const blocked = new Ledger(lp).all().filter((e) => e.action === "guardrail.blocked");
  assert.equal(blocked.length, 2);
  assert.equal(blocked[0]!.actor.name, "claude-code");
  assert.equal(Ledger.verify(lp).ok, true);
});

test("PreToolUse: a broken ledger fails open (never wedges the agent) but says so on stderr", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hook-"));
  mkdirSync(join(cwd, ".handoff"), { recursive: true });
  writeFileSync(join(cwd, ".handoff", "ledger.jsonl"), "garbage\n");
  const r = run(cwd, { hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
