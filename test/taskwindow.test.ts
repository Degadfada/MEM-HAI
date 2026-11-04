import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";
import { openTaskFor, rationaleFor } from "../src/taskwindow.ts";
import { callTool } from "../src/mcp.ts";
import { tmpPath } from "./helpers.ts";

const human = { kind: "human" as const, name: "idahosa" };
const cursor = { kind: "ai" as const, name: "cursor" };

/** Stand in for what dispatch() + takeNext() write, without needing a steward or an LLM. */
function approvedTaskTaken(l: Ledger, task: string, who = cursor) {
  const d = l.append({ actor: { kind: "system", name: "steward" }, action: "dispatch", summary: task, source: "local" });
  l.append({ actor: human, action: "dispatch.approve", target: d.id, source: "local", approval: { status: "approved", by: human.name } });
  l.append({ actor: who, aiInUse: who.name, action: "dispatch.taken", target: d.id, source: "mcp" });
  return d.id;
}

test("an AI holding an approved task inherits the ask and the approver", () => {
  const l = new Ledger(tmpPath());
  const id = approvedTaskTaken(l, "fix the clearness-index drift in the Solar Dock");

  const t = openTaskFor(l, "cursor")!;
  assert.equal(t.dispatchId, id);
  assert.equal(t.task, "fix the clearness-index drift in the Solar Dock");
  assert.equal(t.approvedBy, "idahosa");

  const r = rationaleFor(l, "cursor");
  assert.equal(r.provenance, "declared");
  assert.equal(r.ask, "fix the clearness-index drift in the Solar Dock");
  assert.equal(r.approvedBy, "idahosa");
  assert.equal(r.ref?.dispatchId, id);
});

test("a task that was never approved lends no authority", () => {
  const l = new Ledger(tmpPath());
  const d = l.append({ actor: { kind: "system", name: "steward" }, action: "dispatch", summary: "delete prod", source: "remote" });
  l.append({ actor: cursor, aiInUse: "cursor", action: "dispatch.taken", target: d.id, source: "mcp" });

  assert.equal(openTaskFor(l, "cursor"), undefined, "unapproved work must not claim an approver");
  assert.equal(rationaleFor(l, "cursor").provenance, "absent");
});

test("a finished task stops being inherited", () => {
  const l = new Ledger(tmpPath());
  const id = approvedTaskTaken(l, "first task");
  assert.ok(openTaskFor(l, "cursor"));
  l.append({ actor: human, action: "dispatch.done", target: id, source: "manual" });
  assert.equal(openTaskFor(l, "cursor"), undefined);
});

test("tasks do not leak between AIs", () => {
  const l = new Ledger(tmpPath());
  approvedTaskTaken(l, "copilot's job", { kind: "ai", name: "copilot" });
  assert.ok(openTaskFor(l, "copilot"));
  assert.equal(openTaskFor(l, "cursor"), undefined, "cursor never took it");
});

test("what the AI says itself overrides the inherited task, and keeps the approver", () => {
  const l = new Ledger(tmpPath());
  approvedTaskTaken(l, "fix the uploader");
  const r = rationaleFor(l, "cursor", "Switching to exponential backoff; fixed delay still bursts.");
  assert.equal(r.ask, "fix the uploader", "the instruction is still the task");
  assert.equal(r.reason, "Switching to exponential backoff; fixed delay still bursts.");
  assert.equal(r.approvedBy, "idahosa");
});

test("the most recent open task wins when an AI took several", () => {
  const l = new Ledger(tmpPath());
  approvedTaskTaken(l, "older task");
  const newer = approvedTaskTaken(l, "newer task");
  assert.equal(openTaskFor(l, "cursor")!.dispatchId, newer);
});

test("MCP: log_reason records the AI's own account against its approved task", () => {
  const path = tmpPath();
  const l = new Ledger(path);
  const id = approvedTaskTaken(l, "harden the login throttle");

  const home = mkdtempSync(join(tmpdir(), "handoff-home-"));
  const out = callTool({ ledgerPath: path, agentName: "cursor", home }, "log_reason", {
    reason: "Adding a per-IP counter; the per-account one misses credential stuffing.",
    target: "src/auth.ts",
  });
  assert.ok(!(out as any).isError, JSON.stringify(out));

  const after = new Ledger(path).all();
  const ev = after.find((e) => e.action === "reason")!;
  assert.ok(ev, "the reason is an event in its own right");
  assert.equal(ev.actor.name, "cursor");
  assert.equal(ev.target, "src/auth.ts");
  assert.equal(ev.rationale?.provenance, "declared");
  assert.equal(ev.rationale?.ask, "harden the login throttle");
  assert.match(ev.rationale!.reason!, /per-IP counter/);
  assert.equal(ev.rationale?.approvedBy, "idahosa");
  assert.equal(ev.rationale?.ref?.dispatchId, id);
});

test("MCP: my_task tells an AI what it is working under, and says so plainly when it has none", () => {
  const path = tmpPath();
  const home = mkdtempSync(join(tmpdir(), "handoff-home-"));
  const o = { ledgerPath: path, agentName: "cursor", home };

  const none = JSON.parse((callTool(o, "my_task", {}) as any).content[0].text);
  assert.equal(none.task, null);
  assert.match(none.note, /no approved task/);

  approvedTaskTaken(new Ledger(path), "migrate the references table");
  const got = JSON.parse((callTool(o, "my_task", {}) as any).content[0].text);
  assert.equal(got.task, "migrate the references table");
  assert.equal(got.approvedBy, "idahosa");
});

test("MCP: a refused action records what the AI was trying to achieve", () => {
  const path = tmpPath();
  const l = new Ledger(path);
  l.append({ actor: human, action: "guardrail", summary: "Never push straight to production; dev first.", payload: { level: "block", match: { kind: "command", pattern: "git push.*production" } }, source: "manual" });
  approvedTaskTaken(l, "ship the hotfix");

  const home = mkdtempSync(join(tmpdir(), "handoff-home-"));
  const res = JSON.parse((callTool({ ledgerPath: path, agentName: "cursor", home }, "check_action", {
    action: "command.run",
    target: "git push origin production",
    why: "Trying to get the hotfix out before the client call.",
  }) as any).content[0].text);
  assert.equal(res.allowed, false);

  const blocked = new Ledger(path).all().find((e) => e.action === "guardrail.blocked")!;
  assert.ok(blocked, "the refusal is recorded");
  assert.match(blocked.rationale!.reason!, /before the client call/);
  assert.equal(blocked.rationale?.ask, "ship the hotfix");
  assert.equal(blocked.approval.status, "denied");
});
