#!/usr/bin/env node
// Claude Code hook -> handoff ledger. Always exits 0. It prints to stdout ONLY to deny a tool call that breaks a block-level guardrail (PreToolUse).
// Wire it to PostToolUse and Notification (see "Handoff: Install Claude Code hook" in VS Code, or hooks/README).
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const cwd = input.cwd || process.cwd();
  const ledgerPath = process.env.HANDOFF_LEDGER || join(cwd, ".handoff", "ledger.jsonl");
  const marker = join(dirname(ledgerPath), ".pending-permission");
  const coreDir = process.env.HANDOFF_CORE || (existsSync(join(here, "core", "ledger.js")) ? join(here, "core") : join(here, "..", "dist"));
  const { Ledger } = await import(new URL("file://" + join(coreDir, "ledger.js")).href);
  const { liveGuardrails, evaluate, logBlocked } = await import(new URL("file://" + join(coreDir, "guardrails.js")).href);

  mkdirSync(dirname(ledgerPath), { recursive: true });
  const ai = { kind: "ai", name: "claude-code" };
  const rel = (p) => (p && isAbsolute(p) ? relative(cwd, p) : p);

  const attemptOf = (tool, ti) => {
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return { action: "file.edit", target: rel(ti.file_path || ti.notebook_path) };
    if (tool === "Bash") return { action: "command.run", target: String(ti.command || "") };
    return null;
  };

  if (input.hook_event_name === "PreToolUse") {
    const att = attemptOf(input.tool_name, input.tool_input || {});
    if (att) {
      const ledger = new Ledger(ledgerPath);
      const verdict = evaluate(liveGuardrails(ledger, process.env.HANDOFF_HOME || join(process.env.HOME || process.env.USERPROFILE || "", ".handoff")), att);
      if (!verdict.allowed) {
        logBlocked(ledger, ai, att, verdict, "hook");
        const why = "Blocked by project guardrail: " + verdict.violations.filter((v) => v.level === "block").map((v) => v.text).join("; ");
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } }));
      }
    }
  } else if (input.hook_event_name === "Notification") {
    // Claude Code shows this when it is waiting on the human for permission.
    if (/permission/i.test(String(input.message || ""))) writeFileSync(marker, String(Date.now()));
  } else if (input.hook_event_name === "PostToolUse") {
    const tool = input.tool_name, ti = input.tool_input || {};
    let ev = null;
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
      ev = { action: tool === "Write" && input.tool_response?.type === "create" ? "file.create" : "file.edit", target: rel(ti.file_path || ti.notebook_path), summary: tool };
    } else if (tool === "Bash") {
      ev = { action: "command.run", target: String(ti.command || "").slice(0, 300), summary: ti.description || "" };
    }
    if (ev) {
      // PostToolUse only fires for tools that ran. If a permission prompt was shown just before, the human said yes.
      let approval = { status: "not_required" };
      if (existsSync(marker)) {
        const age = Date.now() - statSync(marker).mtimeMs;
        if (age < 10 * 60 * 1000) approval = { status: "approved", by: "human", at: new Date().toISOString() };
        unlinkSync(marker);
      }
      new Ledger(ledgerPath).append({ actor: ai, aiInUse: "claude-code", source: "hook", approval, ...ev });
    }
  }
} catch (e) {
  try { process.stderr.write("handoff hook: " + (e && e.message) + "\n"); } catch {}
}
process.exit(0);
