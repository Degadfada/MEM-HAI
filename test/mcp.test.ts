import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { addGuardrail } from "../src/guardrails.ts";
import { openContract } from "../src/scope.ts";
import { tmpPath } from "./helpers.ts";

const me = { kind: "human" as const, name: "me" };

/** Talks to the REAL server process over stdio, the way an MCP client would. */
function client(lp: string, agent: string) {
  const p = spawn("node", [resolve("dist/cli.js"), "mcp", "--file", lp, "--agent", agent], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = ""; const waiting = new Map<number, (v: any) => void>(); let n = 0;
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d: string) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  return {
    call: (method: string, params?: object) => new Promise<any>((ok) => { const id = ++n; waiting.set(id, ok); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }),
    notify: (method: string) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"),
    raw: (s: string) => p.stdin.write(s + "\n"),
    close: () => p.kill(),
  };
}
const tool = async (c: ReturnType<typeof client>, name: string, args: object = {}) => (await c.call("tools/call", { name, arguments: args })).result;

test("MCP: handshake, tool list, resources", async () => {
  const lp = tmpPath(); new Ledger(lp);
  const c = client(lp, "cursor");
  const init = await c.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.result.serverInfo.name, "handoff-ledger");
  assert.ok(init.result.capabilities.tools);
  c.notify("notifications/initialized");
  const tools = (await c.call("tools/list")).result.tools.map((t: any) => t.name);
  for (const n of ["get_brief", "get_guardrails", "check_action", "check_scope", "confirm_acceptance", "audit_contract", "log_decision"]) assert.ok(tools.includes(n), n);
  assert.equal((await c.call("resources/list")).result.resources.length, 3);
  assert.equal((await c.call("nope")).error.code, -32601);
  c.raw("this is not json");
  c.close();
});

test("MCP: a connected AI is told the rules, is blocked by them, and its attempt is recorded", async () => {
  const lp = tmpPath();
  const l = new Ledger(lp);
  addGuardrail(l, me, "block", "Never run destructive SQL", { kind: "command", pattern: "drop\\s+table" });
  openContract(l, me, { id: "login-limit", goal: "Rate limit /login", acceptance: ["429 after 5 tries"], inScope: ["src/auth/**"] });
  const c = client(lp, "cursor");
  await c.call("initialize", {});
  const brief = (await tool(c, "get_brief")).content[0].text;
  assert.match(brief, /You are cursor/);
  assert.match(brief, /GUARDRAIL.*destructive SQL/);
  assert.match(brief, /CONTRACT login-limit/);
  const bad = JSON.parse((await tool(c, "check_action", { action: "command.run", target: "psql -c 'DROP TABLE users'" })).content[0].text);
  assert.equal(bad.allowed, false);
  const fine = JSON.parse((await tool(c, "check_action", { action: "command.run", target: "pnpm test" })).content[0].text);
  assert.equal(fine.allowed, true);
  assert.equal(JSON.parse((await tool(c, "check_scope", { contract: "login-limit", path: "src/billing/x.ts" })).content[0].text).ok, false);
  assert.equal(JSON.parse((await tool(c, "check_scope", { contract: "login-limit", path: "src/auth/a.ts" })).content[0].text).ok, true);
  assert.equal((await tool(c, "check_scope", { contract: "ghost", path: "x" })).isError, true);
  await tool(c, "confirm_acceptance", { contract: "login-limit", item: 0, evidence: "curl test shows 429" });
  await tool(c, "log_decision", { topic: "limits", decision: "Use a sliding window, not fixed" });
  assert.match((await tool(c, "audit_contract", { contract: "login-limit" })).content[0].text, /All acceptance items confirmed/);
  c.close();
  const ev = new Ledger(lp).all();
  const blocked = ev.find((e) => e.action === "guardrail.blocked")!;
  assert.deepEqual([blocked.actor.name, blocked.source, blocked.approval.by], ["cursor", "mcp", "guardrail"]);
  assert.ok(ev.some((e) => e.action === "decision" && e.actor.name === "cursor"));
  assert.equal(Ledger.verify(lp).ok, true);
});

test("MCP: bad tool arguments return an error result, not a crash", async () => {
  const lp = tmpPath(); new Ledger(lp);
  const c = client(lp, "x");
  await c.call("initialize", {});
  assert.equal((await tool(c, "confirm_acceptance", { contract: "nope", item: 0 })).isError, true);
  assert.equal((await tool(c, "no_such_tool")).isError, true);
  assert.ok((await c.call("ping")).result); // still alive
  c.close();
});
