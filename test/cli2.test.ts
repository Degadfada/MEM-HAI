import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { fakeAi } from "./fakeai.ts";

const home = mkdtempSync(join(tmpdir(), "h-")), proj = mkdtempSync(join(tmpdir(), "p-"));
const lp = join(proj, ".handoff", "ledger.jsonl");
const cli = (args: string[], env: Record<string, string> = {}, input?: string) =>
  spawnSync("node", [resolve("dist/cli.js"), ...args, "--home", home], { encoding: "utf8", input, env: { ...process.env, ...env } });
const L = (args: string[], env?: Record<string, string>) => cli([...args, "--file", lp], env);

test("CLI: plug in providers, wake two, the third displaces; budget; keys are only referenced", async () => {
  const ai = await fakeAi();
  try {
    assert.match(cli(["providers", "add", "--name", "claude", "--kind", "anthropic", "--model", "m", "--key-env", "ANTHROPIC_API_KEY", "--base-url", ai.url]).stdout, /added/);
    cli(["providers", "add", "--name", "local", "--kind", "ollama", "--model", "llama3", "--base-url", ai.url]);
    cli(["providers", "add", "--name", "gem", "--kind", "gemini", "--model", "g", "--key-env", "GEMINI_API_KEY", "--base-url", ai.url]);
    assert.match(cli(["providers", "add", "--name", "claude", "--kind", "ollama", "--model", "m"]).stderr, /already exists/);
    L(["providers", "wake", "--name", "claude", "--role", "steward"]);
    L(["providers", "wake", "--name", "local", "--role", "editor"]);
    const out = L(["providers", "wake", "--name", "gem", "--role", "steward"]).stdout;
    assert.match(out, /"slept":\["claude"\]/);
    const list = cli(["providers", "list"], { GEMINI_API_KEY: "x" }).stdout;
    assert.match(list, /claude\s+asleep/); assert.match(list, /local\s+editor/); assert.match(list, /gem\s+steward/);
    cli(["providers", "budget", "--tokens", "5000"]);
    assert.match(cli(["providers", "list"]).stdout, /\/5000 tokens/);
    assert.match(new Ledger(lp).all().map((e) => e.action).join(), /provider.wake/);
  } finally { await ai.close(); }
});

test("CLI: book -> cards, dispatch -> compiled prompt, approve, review, summary, projects, consolidate, global guardrail", () => {
  const book = join(proj, "book.txt");
  writeFileSync(book, "Always write the failing test first, then the smallest change that makes it pass. Never ask a model for a rewrite when a diff will do.");
  cli(["providers", "sleep", "--name", "gem"]); // no steward awake: the rule-based extractor and rule-based prompts are used
  assert.match(cli(["knowledge", "ingest", "--path", book]).stdout, /rule-based/);
  assert.match(cli(["knowledge", "search", "--q", "failing test"]).stdout, /failing test first/);

  L(["guardrail", "add", "--level", "block", "--text", "No force push", "--kind", "command", "--pattern=--force"]);
  assert.match(cli(["guardrail", "add", "--global", "--level", "block", "--text", "No printenv", "--kind", "command", "--pattern", "printenv"]).stdout, /global:/);

  const d = L(["dispatch", "--task", "write the failing test for the parser"]).stdout;
  assert.match(d, /\(approved, technique \w[\w-]+, \d+ tokens from \d+\)/);
  assert.match(d, /GOAL: write the failing test/);
  assert.match(d, /No force push/); assert.match(d, /No printenv/);
  assert.match(d, /GUIDANCE:[\s\S]*failing test first/);
  assert.match(L(["queue"]).stdout, /approved\s+local\s+write the failing test/);
  assert.match(L(["review"]).stdout, /No open contracts/);
  assert.match(L(["summary", "--name", "demo"]).stdout, /# demo/);

  const p2 = mkdtempSync(join(tmpdir(), "p2-"));
  assert.match(cli(["projects", "add", "--name", "demo", "--root", proj]).stdout, /demo/);
  cli(["projects", "add", "--name", "two", "--root", p2]);
  new Ledger(join(p2, ".handoff", "ledger.jsonl")).append({ actor: { kind: "human", name: "me" }, action: "guardrail", summary: "No force push", payload: { level: "block", match: { kind: "command", pattern: "--force" } } });
  const cons = cli(["projects", "consolidate"]).stdout;
  assert.match(cons, /\[demo,two\].*No force push/);
  assert.match(cli(["projects", "list"]).stdout, /two/);
});

test("CLI: auth set-password reads env, rejects short passwords", () => {
  assert.match(cli(["auth", "set-password"], { HANDOFF_PASSWORD: "a long enough password" }).stdout, /password set/);
  assert.match(cli(["auth", "set-password"], { HANDOFF_PASSWORD: "short" }).stderr, /at least 12/);
});

test("MCP: a connected AI pulls its approved task, finds techniques, sees lessons and machine-wide rules", async () => {
  const p = spawn("node", [resolve("dist/cli.js"), "mcp", "--file", lp, "--agent", "cursor", "--home", home], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = ""; const waiting = new Map<number, (v: any) => void>(); let n = 0;
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d: string) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  const call = (name: string, args: object = {}) => new Promise<any>((ok) => { const id = ++n; waiting.set(id, ok); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n"); });
  const txt = async (name: string, args?: object) => (await call(name, args)).result.content[0].text as string;
  try {
    const task = await txt("next_task");
    assert.match(task, /technique: [\w-]+/);
    assert.match(task, /GOAL: write the failing test/);
    assert.equal(await txt("next_task"), "none", "a task is handed out once");
    assert.match(await txt("find_technique", { query: "failing test first" }), /failing test/);
    assert.match(await txt("get_lessons"), /No force push/);
    assert.match(await txt("get_brief"), /Machine-wide guardrails[\s\S]*No printenv/);
    assert.equal(JSON.parse(await txt("check_action", { action: "command.run", target: "printenv" })).allowed, false, "global rule enforced over MCP");
  } finally { p.kill(); }
});
