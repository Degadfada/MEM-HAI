import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.ts";
import { addGuardrail, evaluate, liveGuardrails, globToRegExp, validateMatch, logBlocked } from "../src/guardrails.ts";
import { openContract, acceptItem, closeContract, audit, liveContracts } from "../src/scope.ts";
import { makeBrief } from "../src/handoff.ts";
import { verifyBrief } from "../src/verify.ts";
import { tmpPath, human, claude } from "./helpers.ts";

const me = { kind: "human" as const, name: "me" };

test("glob matching: ** crosses folders, * does not", () => {
  assert.ok(globToRegExp("src/**").test("src/a/b/c.ts"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("**/.env*").test("config/.env.local"));
  assert.ok(globToRegExp("**/.env*").test(".env"));
  assert.ok(!globToRegExp("a.b").test("axb"));
});

test("block rules deny; advise rules warn but allow", () => {
  const l = new Ledger(tmpPath());
  addGuardrail(l, me, "block", "No force pushes", { kind: "command", pattern: "git\\s+push\\s+.*--force" });
  addGuardrail(l, me, "block", "Never touch env files", { kind: "path", pattern: "**/.env*" });
  addGuardrail(l, me, "advise", "Prefer small commits", { kind: "command", pattern: "git commit -a" });
  addGuardrail(l, me, "block", "No deletions", { kind: "action", pattern: "file.delete" });
  const rules = liveGuardrails(l);
  assert.equal(evaluate(rules, { action: "command.run", target: "git push origin main --force" }).allowed, false);
  assert.equal(evaluate(rules, { action: "file.edit", target: "api/.env.production" }).allowed, false);
  assert.equal(evaluate(rules, { action: "file.delete", target: "src/x.ts" }).allowed, false);
  const adv = evaluate(rules, { action: "command.run", target: "git commit -a -m x" });
  assert.equal(adv.allowed, true);
  assert.equal(adv.violations.length, 1);
  assert.equal(evaluate(rules, { action: "command.run", target: "git push origin main" }).violations.length, 0);
  assert.equal(evaluate(rules, { action: "file.edit", target: "src/ok.ts" }).allowed, true);
});

test("a command rule does not fire on file edits that merely contain the text", () => {
  const l = new Ledger(tmpPath());
  addGuardrail(l, me, "block", "no rm -rf", { kind: "command", pattern: "rm\\s+-rf" });
  assert.equal(evaluate(liveGuardrails(l), { action: "file.edit", target: "rm -rf.md" }).allowed, true);
});

test("revoking a guardrail (reversal) switches it off; invalid or dangerous rules are refused", () => {
  const l = new Ledger(tmpPath());
  const g = addGuardrail(l, me, "block", "no curl", { kind: "command", pattern: "curl" });
  assert.equal(liveGuardrails(l).length, 1);
  l.reverse(g.id, me);
  assert.equal(liveGuardrails(l).length, 0);
  assert.throws(() => addGuardrail(l, me, "block", "bad", { kind: "command", pattern: "(" }), /valid regular/);
  assert.throws(() => addGuardrail(l, me, "block", "redos", { kind: "command", pattern: "(a+)+$" }), /ReDoS/);
  assert.ok(validateMatch({ kind: "weird" as any, pattern: "x" }));
  assert.throws(() => addGuardrail(l, me, "block", "", { kind: "action", pattern: "x" }), /text required/);
});

test("a forged corrupt guardrail event cannot crash enforcement", () => {
  const l = new Ledger(tmpPath());
  l.append({ actor: me, action: "guardrail", summary: "junk", payload: { level: "block", match: { kind: "command", pattern: "(" } } });
  addGuardrail(l, me, "block", "ok rule", { kind: "command", pattern: "wipe" });
  const rules = liveGuardrails(l);
  assert.equal(rules.length, 1);
  assert.equal(evaluate(rules, { action: "command.run", target: "wipe disk" }).allowed, false);
});

test("guardrails reach the brief as hard rules, survive tiny budgets, and blocked attempts are logged without becoming 'human denied'", async () => {
  const l = new Ledger(tmpPath());
  addGuardrail(l, me, "block", "Never edit migrations", { kind: "path", pattern: "db/migrations/**" });
  for (let i = 0; i < 40; i++) l.append({ actor: me, action: "decision", target: "t" + i, summary: "decision number " + i + " about topic " + i * 3 });
  const rules = liveGuardrails(l);
  const a = { action: "file.edit", target: "db/migrations/001.sql" };
  logBlocked(l, { kind: "ai", name: "claude-code" }, a, evaluate(rules, a), "hook");
  const b = makeBrief(l, "copilot", "claude-md", 300);
  assert.match(b.text, /GUARDRAIL.*Never edit migrations/);
  assert.doesNotMatch(b.text, /Human DENIED/);
  assert.equal((await verifyBrief(l, b)).hardMissing.length, 0);
});

// ---- scope contracts ----
test("contract: on-track, then drifting when an AI touches something out of scope", () => {
  const l = new Ledger(tmpPath());
  openContract(l, me, { id: "login-limit", goal: "Rate limit /login", acceptance: ["429 after 5 tries", "test added"], inScope: ["src/auth/**", "test/auth/**"], outOfScope: ["src/auth/legacy/**"] });
  assert.equal(audit(l, "login-limit").verdict, "no-work-yet");
  l.append({ actor: claude, action: "file.edit", target: "src/auth/login.ts" });
  assert.equal(audit(l, "login-limit").verdict, "on-track");
  l.append({ actor: claude, action: "file.edit", target: "src/billing/invoice.ts" });
  l.append({ actor: claude, action: "file.edit", target: "src/auth/legacy/old.ts" });
  const a = audit(l, "login-limit");
  assert.equal(a.verdict, "drifting");
  assert.equal(a.outOfScope.length, 2);
  assert.match(a.outOfScope[0]!.why, /not in any in-scope/);
  assert.match(a.outOfScope[1]!.why, /out-of-scope "src\/auth\/legacy/);
  assert.match(a.text, /OUT OF SCOPE \(2\)/);
});

test("contract: acceptance tracking, completion, closing; reverting the stray edit clears the drift", () => {
  const l = new Ledger(tmpPath());
  openContract(l, me, { id: "c1", goal: "g", acceptance: ["a", "b"], inScope: ["src/**"] });
  const stray = l.append({ actor: claude, action: "file.edit", target: "README.md" });
  assert.equal(audit(l, "c1").verdict, "drifting");
  l.reverse(stray.id, me);
  l.append({ actor: claude, action: "file.edit", target: "src/a.ts" });
  acceptItem(l, claude, "c1", 0);
  let a = audit(l, "c1");
  assert.deepEqual([a.verdict, a.missing], ["on-track", ["b"]]);
  acceptItem(l, me, "c1", 1);
  assert.equal(audit(l, "c1").verdict, "complete");
  closeContract(l, me, "c1");
  assert.equal(liveContracts(l).length, 0);
  assert.equal(audit(l, "c1").closed, true);
});

test("contract: unattributed changes are reported, not blamed; bad input rejected", () => {
  const l = new Ledger(tmpPath());
  openContract(l, me, { id: "c2", goal: "g", inScope: ["src/**"] });
  l.append({ actor: { kind: "unknown", name: "unattributed" }, action: "file.edit", target: "elsewhere.txt" });
  const a = audit(l, "c2");
  assert.equal(a.unattributed, 1);
  assert.equal(a.outOfScope.length, 0);
  assert.throws(() => openContract(l, me, { id: "Bad Id", goal: "x" }), /contract id/);
  assert.throws(() => openContract(l, me, { id: "c2", goal: "x" }), /already open/);
  assert.throws(() => acceptItem(l, me, "c2", 5), /no such acceptance/);
  assert.throws(() => audit(l, "nope"), /no contract/);
});

test("open contract appears in the brief with its done-when and scope", () => {
  const l = new Ledger(tmpPath());
  openContract(l, me, { id: "login-limit", goal: "Rate limit /login", acceptance: ["429 after 5 tries"], inScope: ["src/auth/**"] });
  const b = makeBrief(l, "copilot", "claude-md");
  assert.match(b.text, /CONTRACT login-limit.*Done when: 429 after 5 tries.*Only touch: src\/auth/);
});
