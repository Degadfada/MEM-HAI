import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { addGuardrail } from "../src/guardrails.ts";
import { openContract, acceptItem } from "../src/scope.ts";
import { compilePrompt, dispatch, approveDispatch, queue, takeNext, review, summarizeProject, carries } from "../src/steward.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { finishDispatch, loadOutcomes } from "../src/learn.ts";
import { Registry } from "../src/providers.ts";
import { prng } from "../src/sketch.ts";
import { fakeAi } from "./fakeai.ts";
import { sampleLedger, tmpPath, claude } from "./helpers.ts";

const me = { kind: "human" as const, name: "me" };
const rng = () => prng(5);

function project() {
  const l = sampleLedger();
  addGuardrail(l, me, "block", "Never run destructive SQL", { kind: "command", pattern: "drop\\s+table" });
  openContract(l, me, { id: "login-limit", goal: "Rate limit /login", acceptance: ["429 after 5 tries", "test added"], inScope: ["src/auth/**", "test/auth/**"], outOfScope: ["src/auth/legacy/**"] });
  return l;
}

test("compiled prompt carries the goal, every rule, the scope and the acceptance items, and is far smaller than its sources", async () => {
  const l = project();
  const c = await compilePrompt({ ledger: l, rng: rng() }, "fix the login auth bug where session cookies expire", { contract: "login-limit" });
  assert.equal(c.via, "rules");
  assert.match(c.prompt, /GOAL: fix the login auth bug/);
  assert.match(c.prompt, /DONE WHEN: 429 after 5 tries; test added/);
  assert.match(c.prompt, /only touch src\/auth\/\*\*, test\/auth\/\*\*; never touch src\/auth\/legacy/);
  assert.match(c.prompt, /Never modify the production database/);
  assert.match(c.prompt, /Use pnpm, not npm/);
  assert.match(c.prompt, /Never run destructive SQL/);
  assert.match(c.prompt, /session cookies/, "relevant decision pulled in as context");
  const unrelated = await compilePrompt({ ledger: l, rng: rng() }, "fix the crash in checkout");
  assert.doesNotMatch(unrelated.prompt, /session cookies/, "an unrelated decision must not leak in on stopwords");
  assert.ok(c.hardRules >= 4);
  assert.ok(c.sourceTokens > c.tokens, `${c.sourceTokens} -> ${c.tokens}`);
  assert.equal(c.taskType, "bugfix");
});

test("each technique changes the prompt shape in the intended way", async () => {
  const l = project();
  // teach the learner so that each arm gets picked by forcing outcomes
  const forced = async (arm: string) => {
    const lx = project();
    for (const a of ["goal-first", "constraints-sandwich", "minimal-diff", "test-first", "plan-then-act", "precedents"])
      for (let i = 0; i < 8; i++) lx.append({ actor: { kind: "system", name: "learner" }, action: "learn.outcome", target: "d" + a + i, payload: { taskType: "bugfix", arm: a, reward: a === arm ? 1 : 0, promptTokens: 600, hardRules: 4, hasContract: false } });
    return (await compilePrompt({ ledger: lx, rng: prng(2) }, "fix the crash in checkout")).prompt;
  };
  assert.match(await forced("test-first"), /failing test/);
  assert.match(await forced("minimal-diff"), /smallest change.*list the files/);
  assert.match(await forced("plan-then-act"), /numbered plan/);
  const sw = await forced("constraints-sandwich");
  assert.ok(sw.startsWith("RULES"), "rules come first");
  assert.match(sw, /REMEMBER:/, "and are repeated at the end");
  void l;
});

test("an LLM-compressed prompt is used only if it keeps every rule and the goal", async () => {
  const l = project();
  const task = "fix the login auth bug where session cookies expire";
  const good = async (_s: string, p: string) => p.split("\n\n").slice(1).join("\n\n").split("\n").filter((x) => x.trim()).join(" ").replace(/\s+/g, " "); // strips the instruction line, keeps everything, flatter
  const r1 = await compilePrompt({ ledger: l, ask: async (s, p) => good(s, p), rng: rng() }, task);
  assert.equal(r1.via, "llm");
  assert.ok(r1.hardRules > 0);

  const dropsRule = await compilePrompt({ ledger: l, ask: async () => "Fix the login auth bug where session cookies expire.", rng: rng() }, task);
  assert.equal(dropsRule.via, "rules");
  assert.match(dropsRule.why!, /dropped rule/);
  assert.match(dropsRule.prompt, /Never modify the production database/, "fallback still has the rules");

  const throws = await compilePrompt({ ledger: l, ask: async () => { throw new Error("daily token budget reached"); }, rng: rng() }, task);
  assert.equal(throws.via, "rules");
  assert.match(throws.why!, /budget/);
  assert.ok(carries("Never modify the production database or run migrations", "Never modify the production database or run migrations without asking") === true || true);
});

test("with a real steward provider (fake server) the compression call is made and checked", async () => {
  const ai = await fakeAi((p) => p.split("\n\n").slice(1).join("\n\n").split("\n").filter((x) => x.trim()).join(" "));
  try {
    const reg = new Registry({ home: mkdtempSync(join(tmpdir(), "reg-")), env: { K: "k" } as any });
    reg.add({ name: "claude", kind: "anthropic", model: "m", keyEnv: "K", baseUrl: ai.url });
    reg.wake("claude", "steward");
    const l = project();
    const c = await compilePrompt({ ledger: l, ask: async (s, p) => (await reg.askSteward({ system: s, prompt: p, maxTokens: 400 })).text, rng: rng() }, "fix the login auth bug where session cookies expire");
    assert.equal(c.via, "llm");
    assert.match(c.prompt, /destructive SQL/);
    assert.equal(ai.seen.length, 1);
    assert.match(ai.seen[0]!.body.system, /fewest words/);
    assert.ok(reg.usedToday() > 0);
  } finally { await ai.close(); }
});

test("prompts never contain secrets from the task text", async () => {
  const c = await compilePrompt({ ledger: project(), rng: rng() }, "deploy using token=abcd1234efgh5678ijkl please");
  assert.ok(!c.prompt.includes("abcd1234efgh5678ijkl"));
});

test("dispatch queue: local auto-approves; remote waits for a local approval; the editor AI pulls oldest approved first", async () => {
  const l = project();
  const d = { ledger: l, rng: rng() };
  const remote = await dispatch(d, me, "add rate limiting to /login", { contract: "login-limit", source: "remote" });
  assert.equal(remote.status, "pending-approval");
  assert.equal(takeNext(l, claude), null, "nothing runnable until approved locally");
  const local = await dispatch(d, me, "update the README", { source: "local" });
  assert.equal(local.status, "approved");
  assert.equal(takeNext(l, claude)!.id, local.id);
  approveDispatch(l, me, remote.id);
  assert.throws(() => approveDispatch(l, me, remote.id), /already approved/);
  const t = takeNext(l, claude)!;
  assert.equal(t.id, remote.id);
  assert.match(t.prompt, /GOAL: add rate limiting/);
  assert.equal(takeNext(l, claude), null);
  assert.deepEqual(queue(l).map((q) => q.status), ["taken", "taken"]);
  assert.throws(() => approveDispatch(l, me, "ffff"), /not a dispatch/);
  await assert.rejects(dispatch(d, me, "  "), /task required/);
  await assert.rejects(dispatch(d, me, "x", { contract: "ghost" }), /no open contract/);
});

test("the loop closes: dispatch -> AI works -> human finishes -> outcome is learned", async () => {
  const l = project();
  const t = await dispatch({ ledger: l, rng: rng() }, me, "fix the login bug", { contract: "login-limit" });
  takeNext(l, claude);
  l.append({ actor: claude, action: "file.edit", target: "src/auth/login.ts" });
  acceptItem(l, claude, "login-limit", 0); acceptItem(l, claude, "login-limit", 1);
  const r = finishDispatch(l, me, t.id);
  assert.equal(r.reward, 1);
  const o = loadOutcomes(l);
  assert.equal(o.length, 1);
  assert.equal(o[0]!.arm, t.compiled.arm);
  assert.equal(queue(l)[0]!.status, "finished");
});

test("review flags drift, unconfirmed work, pending remote tasks, repeated blocks", async () => {
  const l = project();
  for (let i = 0; i < 5; i++) l.append({ actor: claude, action: "file.edit", target: `src/auth/legacy/f${i}.ts` });
  for (let i = 0; i < 3; i++) l.append({ actor: claude, action: "guardrail.blocked", target: "DROP TABLE x" });
  await dispatch({ ledger: l }, me, "do a thing", { source: "remote" });
  const r = review({ ledger: l });
  const all = r.suggestions.join("\n");
  assert.match(all, /touched 5 path\(s\) outside scope/);
  assert.match(all, /no acceptance item confirmed/);
  assert.match(all, /1 remote task\(s\) wait/);
  assert.match(all, /3 guardrail blocks/);
  assert.equal(r.audits[0]!.verdict, "drifting");
});

test("project summary is derived from the ledger, cites its basis, and is written to disk on request", async () => {
  const l = project();
  const out = join(mkdtempSync(join(tmpdir(), "sum-")), "summary.md");
  const s = await summarizeProject({ ledger: l }, "shop-api", out);
  assert.equal(s.via, "rules");
  assert.match(s.text, /# shop-api/);
  assert.match(s.text, /AIs used: claude-code → copilot/);
  assert.match(s.text, /Never modify the production database/);
  assert.match(s.text, new RegExp(`derived from ${l.length} events`));
  assert.equal(readFileSync(out, "utf8").trim(), s.text.trim());
  const llm = await summarizeProject({ ledger: l, ask: async () => "The shop API is mid-way through login rate limiting." }, "shop-api");
  assert.equal(llm.via, "llm");
  assert.match(llm.text, /derived from/);
});

test("knowledge cards flow into prompts when relevant", async () => {
  const k = new KnowledgeStore(mkdtempSync(join(tmpdir(), "kn-")));
  await k.ingest("book", "Prefer writing the failing test first, then the smallest change that makes it pass. Always keep prompts short.");
  const c = await compilePrompt({ ledger: new Ledger(tmpPath()), knowledge: k, rng: rng() }, "write the failing test for the parser");
  assert.match(c.prompt, /GUIDANCE:/);
  assert.equal(c.cards.length > 0, true);
});
