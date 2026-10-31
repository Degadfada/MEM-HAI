import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { redactString } from "../src/redact.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
const human = { kind: "human" as const, name: "me" };
const ai = { kind: "ai" as const, name: "claude-code" };

test("append builds a verifiable chain", () => {
  const p = tmp();
  const l = new Ledger(p);
  l.append({ actor: ai, action: "file.edit", target: "a.ts", aiInUse: "claude-code" });
  l.append({ actor: human, action: "approve", approval: { status: "approved", by: "me" } });
  assert.deepEqual(Ledger.verify(p), { ok: true, events: 2 });
});

test("reopening an existing ledger continues the chain", () => {
  const p = tmp();
  new Ledger(p).append({ actor: ai, action: "x" });
  new Ledger(p).append({ actor: ai, action: "y" });
  assert.deepEqual(Ledger.verify(p), { ok: true, events: 2 });
});

test("tampering with an event is detected", () => {
  const p = tmp();
  const l = new Ledger(p);
  l.append({ actor: ai, action: "file.edit", target: "a.ts" });
  l.append({ actor: ai, action: "file.edit", target: "b.ts" });
  const txt = readFileSync(p, "utf8").replace("a.ts", "evil.ts");
  writeFileSync(p, txt);
  const r = Ledger.verify(p);
  assert.equal(r.ok, false);
  assert.match(r.error!, /altered/);
});

test("deleting a middle event is detected", () => {
  const p = tmp();
  const l = new Ledger(p);
  for (let i = 0; i < 3; i++) l.append({ actor: ai, action: "e" + i });
  const lines = readFileSync(p, "utf8").trimEnd().split("\n");
  lines.splice(2, 1);
  writeFileSync(p, lines.join("\n") + "\n");
  assert.equal(Ledger.verify(p).ok, false);
});

test("secrets are redacted before they reach disk", () => {
  const p = tmp();
  const l = new Ledger(p);
  const key = "sk-ant-" + "a".repeat(40);
  const gh = "ghp_" + "B".repeat(36);
  const e = l.append({
    actor: ai,
    action: "command.run",
    summary: `curl -H "Authorization: Bearer ${"x".repeat(30)}" with ${key}`,
    payload: { env: { DB_PASSWORD: "hunter2hunter2", note: `token ${gh}` } },
  });
  const disk = readFileSync(p, "utf8");
  for (const s of [key, gh, "hunter2hunter2", "x".repeat(30)]) assert.ok(!disk.includes(s), `leaked ${s}`);
  assert.ok(e.redactions && e.redactions.count >= 4);
  assert.equal(Ledger.verify(p).ok, true);
});

test("redactString leaves ordinary text alone", () => {
  const r = redactString("edited src/auth.ts to add a password field label");
  assert.equal(r.count, 0);
});

test("url credentials are redacted", () => {
  assert.equal(redactString("postgres://bob:s3cret@db/x").text, "postgres://[REDACTED:url-credentials]@db/x");
});

test("reversal is a negative update and cannot go below zero", () => {
  const p = tmp();
  const l = new Ledger(p);
  const e = l.append({ actor: ai, action: "file.edit", target: "a.ts" });
  const r = l.reverse(e.id, human);
  assert.equal(r.delta, -1);
  assert.equal(r.reverses, e.id);
  assert.ok(l.isReversed(e.id));
  assert.throws(() => l.reverse(e.id, human), /already reversed/);
  assert.throws(() => l.reverse(r.id, human), /cannot reverse a reversal/);
  assert.throws(() => l.reverse("deadbeefdeadbeef", human), /unknown event/);
  assert.equal(Ledger.verify(p).ok, true);
});

test("forged double reversal fails verification", () => {
  const p = tmp();
  const l = new Ledger(p);
  const e = l.append({ actor: ai, action: "x" });
  l.reverse(e.id, human);
  const lines = readFileSync(p, "utf8").trimEnd().split("\n");
  assert.equal(Ledger.verify(p).ok, true);
  // Rebuild a valid-hash chain containing two reversals by writing through a fresh ledger API bypass.
  const l2 = new Ledger(p);
  (l2 as any).reversed.delete(e.id); // simulate a buggy/malicious writer
  l2.append({ actor: human, action: "reversal", reverses: e.id });
  const r = Ledger.verify(p);
  assert.equal(r.ok, false);
  assert.match(r.error!, /turnstile/);
  assert.ok(lines.length === 3);
});

test("event ids are 64-bit hex and unique across many events", () => {
  const p = tmp();
  const l = new Ledger(p);
  const ids = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const e = l.append({ actor: ai, action: "e" });
    assert.match(e.id, /^[0-9a-f]{16}$/);
    ids.add(e.id);
  }
  assert.equal(ids.size, 2000);
});

test("header stores sketch seeds that persist across reopen", () => {
  const p = tmp();
  const a = new Ledger(p).header.seeds;
  const b = new Ledger(p).header.seeds;
  assert.deepEqual(a, b);
  assert.equal(a.countMin.length, 8);
  assert.equal(new Set(a.countMin).size, 8);
});

test("approval and ai-in-use are recorded", () => {
  const p = tmp();
  const l = new Ledger(p);
  const e = l.append({
    actor: ai,
    action: "command.run",
    aiInUse: "copilot",
    approval: { status: "approved", by: "me", at: "2026-10-30T10:00:00Z" },
  });
  assert.equal(e.aiInUse, "copilot");
  assert.equal(e.approval.status, "approved");
});
