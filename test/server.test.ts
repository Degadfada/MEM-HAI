import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { startServer } from "../src/server.ts";
import { Ledger } from "../src/ledger.ts";
import { sampleLedger } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "srv-"));
const lp = join(dir, "ledger.jsonl");
const seed = sampleLedger(); // copy a realistic ledger into place
import { copyFileSync } from "node:fs";
copyFileSync(seed.path, lp);
const srv = await startServer({ ledgerPath: lp, projectRoot: dir });
after(() => srv.close());

const call = async (path: string, init: RequestInit = {}, tok: string | null = srv.token) =>
  fetch(`http://127.0.0.1:${srv.port}${path}`, { ...init, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), "content-type": "application/json" } });

test("binds to loopback only", () => {
  assert.equal((srv.server.address() as any).address, "127.0.0.1");
});

test("page loads without a token; API refuses without or with a wrong token", async () => {
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/`)).status, 200);
  assert.equal((await call("/api/summary", {}, null)).status, 401);
  assert.equal((await call("/api/summary", {}, "wrong")).status, 401);
  assert.equal((await call("/api/summary")).status, 200);
});

test("DNS-rebinding style Host header is rejected", async () => {
  const status = await new Promise<number>((ok) => {
    http.get({ host: "127.0.0.1", port: srv.port, path: "/api/summary", headers: { host: "evil.example", authorization: `Bearer ${srv.token}` } }, (r) => { r.resume(); ok(r.statusCode!); });
  });
  assert.equal(status, 403);
});

test("summary reports ledger integrity, AI trail and counts", async () => {
  const s: any = await (await call("/api/summary")).json();
  assert.equal(s.verify.ok, true);
  assert.deepEqual(s.aiTrail, ["claude-code", "copilot"]);
  assert.equal(s.currentAi, "copilot");
  assert.ok(s.approvals.approved > 30 && s.approvals.denied === 1);
});

test("POST /api/events appends, rejects junk, redacts secrets", async () => {
  assert.equal((await call("/api/events", { method: "POST", body: "{}" })).status, 400);
  const r: any = await (await call("/api/events", { method: "POST", body: JSON.stringify({ actor: { kind: "human", name: "me" }, action: "decision", target: "deploy", summary: "use token=abcd1234efgh5678ijkl" }) })).json();
  assert.match(r.summary, /REDACTED/);
  assert.equal(Ledger.verify(lp).ok, true);
});

test("oversized body is refused", async () => {
  let failed = false;
  try { const r = await call("/api/events", { method: "POST", body: "x".repeat(400 * 1024) }); failed = r.status >= 400; } catch { failed = true; }
  assert.ok(failed);
});

test("/api/switch logs the switch, returns a verified brief and writes the file", async () => {
  const r: any = await (await call("/api/switch", { method: "POST", body: JSON.stringify({ to: "codex", target: "agents-md", write: true }) })).json();
  assert.equal(r.verification.pass, true);
  assert.equal(r.metrics.hardKept, r.metrics.hardTotal);
  assert.ok(existsSync(join(dir, "AGENTS.md")));
  assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /You are codex, taking over/);
  const s: any = await (await call("/api/summary")).json();
  assert.equal(s.currentAi, "codex");
});

test("reverse via API turns an event into a struck-through undo", async () => {
  const ev: any[] = await (await call("/api/events?limit=5")).json();
  const target = ev.find((e) => e.action === "decision" && !e.reversed)!;
  await call("/api/reverse", { method: "POST", body: JSON.stringify({ id: target.id }) });
  const again: any[] = await (await call("/api/events?limit=10")).json();
  assert.equal(again.find((e) => e.id === target.id).reversed, true);
});

test("brief endpoint validates target", async () => {
  assert.equal((await call("/api/brief?target=nope")).status, 400);
  const b: any = await (await call("/api/brief?target=system-prompt&to=gemini")).json();
  assert.match(b.text, /You are gemini/);
});

test("guardrail + contract endpoints: create, list with live audit, accept, close, validate", async () => {
  assert.equal((await call("/api/guardrails", { method: "POST", body: JSON.stringify({ text: "x", match: { kind: "command", pattern: "(" } }) })).status, 400);
  const g: any = await (await call("/api/guardrails", { method: "POST", body: JSON.stringify({ text: "No curl|sh", level: "block", match: { kind: "command", pattern: "curl.*\\|\\s*sh" } }) })).json();
  assert.equal(g.action, "guardrail");
  assert.ok((await (await call("/api/guardrails")).json() as any[]).some((x) => x.text === "No curl|sh"));

  assert.equal((await call("/api/contracts", { method: "POST", body: JSON.stringify({ id: "Bad Id", goal: "x" }) })).status, 400);
  await call("/api/contracts", { method: "POST", body: JSON.stringify({ id: "ui-fix", goal: "Fix header", acceptance: ["looks right"], inScope: ["src/ui/**"] }) });
  await call("/api/events", { method: "POST", body: JSON.stringify({ actor: { kind: "ai", name: "codex" }, action: "file.edit", target: "src/server/x.ts" }) });
  let cs: any[] = await (await call("/api/contracts")).json();
  let c = cs.find((x) => x.id === "ui-fix");
  assert.equal(c.audit.verdict, "drifting");
  assert.equal(c.audit.outOfScope[0].target, "src/server/x.ts");
  assert.equal((await call("/api/contracts/accept", { method: "POST", body: JSON.stringify({ id: "ui-fix", item: 0 }) })).status, 200);
  await call("/api/contracts/close", { method: "POST", body: JSON.stringify({ id: "ui-fix" }) });
  cs = await (await call("/api/contracts")).json();
  assert.ok(!cs.some((x) => x.id === "ui-fix"));
});
