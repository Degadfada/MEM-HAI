import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Ledger } from "../src/ledger.ts";

const require = createRequire(import.meta.url);
const Module = require("node:module");

// ---- a minimal fake of the vscode API surface the extension uses ----
const root = mkdtempSync(join(tmpdir(), "ws-"));
const answers: unknown[] = []; // queued answers for quick picks / input boxes
const messages: string[] = [];
const commands = new Map<string, (...a: any[]) => any>();
const cb: Record<string, Array<(x: any) => void>> = { save: [], create: [], change: [], delete: [] };
const status: any = { text: "", show() {}, dispose() {} };
const opened: string[] = [];
let clipboard = "";
const outLines: string[] = [];
process.env.HANDOFF_HOME = mkdtempSync(join(tmpdir(), "xhome-"));
const fake = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: root } }],
    getConfiguration: () => ({ get: (k: string) => ({ ledgerPath: ".handoff/ledger.jsonl", humanName: "tester", knownAis: ["claude-code", "copilot"], watchFiles: true } as any)[k] }),
    openTextDocument: async (o: any) => ({ content: o.content }),
    onDidSaveTextDocument: (f: any) => (cb.save!.push(f), { dispose() {} }),
    createFileSystemWatcher: () => ({
      onDidCreate: (f: any) => cb.create!.push(f), onDidChange: (f: any) => cb.change!.push(f), onDidDelete: (f: any) => cb.delete!.push(f), dispose() {},
    }),
  },
  window: {
    createStatusBarItem: () => status,
    showQuickPick: async (items: any[]) => { const a = answers.shift(); return typeof a === "number" ? items[a] : a; },
    showInputBox: async () => answers.shift(),
    showInformationMessage: async (m: string) => (messages.push(m), undefined),
    showWarningMessage: async (m: string) => (messages.push(m), "Overwrite"),
    showTextDocument: async () => undefined,
    createOutputChannel: () => ({ clear() {}, appendLine(l: string) { outLines.push(l); }, show() {} }),
    showErrorMessage: async (m: string) => (messages.push("ERR " + m), undefined),
  },
  commands: { registerCommand: (id: string, fn: any) => (commands.set(id, fn), { dispose() {} }) },
  env: { clipboard: { writeText: async (t: string) => void (clipboard = t) }, openExternal: async (u: any) => (opened.push(u.toString ? u.toString() : u), true) },
  StatusBarAlignment: { Left: 1 },
  RelativePattern: class { b: any; p: string; constructor(b: any, p: string) { this.b = b; this.p = p; } },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
};
const origLoad = Module._load;
Module._load = function (req: string, ...rest: any[]) { return req === "vscode" ? fake : origLoad.call(this, req, ...rest); };

const ext = require(resolve("extension/extension.js"));
const ctx = { extensionPath: resolve("extension"), subscriptions: [] as any[] };
const api = await ext.activate(ctx);
const lp = join(root, ".handoff", "ledger.jsonl");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("activates, registers every command, creates the ledger, shows status", () => {
  assert.equal(commands.size, 17);
  assert.ok(existsSync(lp));
  assert.match(status.text, /no AI/);
});

test("a human save is logged as the human, not an AI", () => {
  mkdirSync(join(root, "src"), { recursive: true });
  cb.save![0]!({ uri: { scheme: "file", fsPath: join(root, "src/app.ts") } });
  const e = new Ledger(lp).all().at(-1)!;
  assert.deepEqual([e.actor.kind, e.actor.name, e.action, e.target, e.source], ["human", "tester", "file.edit", "src/app.ts", "vscode-save"]);
});

test("ignored folders (node_modules, .git, .handoff) are never logged", () => {
  const before = new Ledger(lp).length;
  api._test.logFileEvent("file.edit", join(root, "node_modules/x/y.js"), "t", { kind: "unknown", name: "u" });
  api._test.logFileEvent("file.edit", join(root, ".git/HEAD"), "t", { kind: "unknown", name: "u" });
  api._test.logFileEvent("file.edit", join(root, ".handoff/ledger.jsonl"), "t", { kind: "unknown", name: "u" });
  assert.equal(new Ledger(lp).length, before);
});

test("an unclaimed file change is logged as unknown; one claimed by an AI hook seconds earlier is not double-counted", async () => {
  // unclaimed
  cb.change![0]!({ fsPath: join(root, "src/b.ts") });
  await sleep(1000);
  let e = new Ledger(lp).all().at(-1)!;
  assert.deepEqual([e.actor.kind, e.target, e.source], ["unknown", "src/b.ts", "vscode-watch"]);
  // claimed: run the real hook, then the watcher fires for the same file
  spawnSync("node", [resolve("hooks/claude-code-hook.mjs")], { input: JSON.stringify({ hook_event_name: "PostToolUse", cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "src/c.ts") } }), env: { ...process.env, HANDOFF_CORE: resolve("dist") } });
  const n = new Ledger(lp).length;
  cb.change![0]!({ fsPath: join(root, "src/c.ts") });
  await sleep(1000);
  assert.equal(new Ledger(lp).length, n, "AI-attributed change must not be logged again");
  e = new Ledger(lp).all().at(-1)!;
  assert.equal(e.actor.kind, "ai");
});

test("record rule / decision / task / refusal commands write the right events", async () => {
  answers.push("Never touch prod"); await commands.get("handoff.addRule")!();
  answers.push("Use Postgres", "db"); await commands.get("handoff.recordDecision")!();
  answers.push("add login throttle", "throttle"); await commands.get("handoff.addTask")!();
  answers.push("rm -rf /var/data"); await commands.get("handoff.recordRefusal")!();
  const ev = new Ledger(lp).all().slice(-4);
  assert.deepEqual(ev.map((e) => e.action), ["constraint", "decision", "task.open", "refused"]);
  assert.equal(ev[3]!.approval.status, "denied");
  assert.equal(ev[3]!.actor.kind, "ai");
  answers.push("throttle"); await commands.get("handoff.doneTask")!();
  assert.equal(new Ledger(lp).all().at(-1)!.action, "task.done");
});

test("Switch AI: logs the switch, writes a verified CLAUDE.md that keeps hard rules, updates the status bar", async () => {
  answers.push("copilot", 0); // pick AI, pick CLAUDE.md
  await commands.get("handoff.switchAi")!();
  const md = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.match(md, /You are copilot, taking over/);
  assert.match(md, /Never touch prod/);
  assert.match(md, /rm -rf \/var\/data/); // the refusal survives the handoff
  assert.doesNotMatch(md, /throttle/); // finished task is gone
  assert.match(status.text, /copilot/);
  assert.match(messages.at(-1)!, /Verified/);
  assert.equal(Ledger.verify(lp).ok, true);
});

test("Switch to system prompt copies to clipboard", async () => {
  answers.push("claude-code", 2);
  await commands.get("handoff.switchAi")!();
  assert.match(clipboard, /You are claude-code, taking over/);
});

test("Install Claude Code hook: settings merged, files copied, and the INSTALLED hook really logs", async () => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { PostToolUse: [{ matcher: "Other", hooks: [{ type: "command", command: "echo hi" }] }] } }));
  await commands.get("handoff.installClaudeHook")!();
  await commands.get("handoff.installClaudeHook")!(); // idempotent
  const s = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.permissions, { allow: ["Read"] }, "existing settings preserved");
  assert.equal(s.hooks.PostToolUse.length, 2, "existing hook kept, ours added once");
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.Notification.length, 1);
  const before = new Ledger(lp).length;
  const r = spawnSync("node", [join(root, ".handoff", "claude-code-hook.mjs")], { cwd: root, input: JSON.stringify({ hook_event_name: "PostToolUse", cwd: root, tool_name: "Bash", tool_input: { command: "pnpm test" } }), encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(new Ledger(lp).length, before + 1);
});

test("Dashboard command starts the local server and the URL really serves the ledger", async () => {
  await commands.get("handoff.openDashboard")!();
  const url = new URL(opened.at(-1)!);
  assert.equal(url.hostname, "127.0.0.1");
  const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
  const s: any = await (await fetch(`http://127.0.0.1:${url.port}/api/summary`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.ok(s.events > 10 && s.verify.ok);
});

test("Verify ledger command reports intact, then reports tamper", async () => {
  await commands.get("handoff.verifyLedger")!();
  assert.match(messages.at(-1)!, /intact/);
  writeFileSync(lp, readFileSync(lp, "utf8").replace("Use Postgres", "Use Mongo"));
  await commands.get("handoff.verifyLedger")!();
  assert.match(messages.at(-1)!, /ERR Ledger FAILED/);
});



test("extension: guardrail and contract commands write real rules, and audit reports drift", async () => {
  // these run after the tamper test, so start a clean ledger
  writeFileSync(lp, ""); // (extension reopens each time)
  rmSyncSafe(lp);
  answers.push("Never edit migrations", { id: "path" }, "db/migrations/**", { id: "block" });
  await commands.get("handoff.addGuardrail")!();
  answers.push("login-limit", "Rate limit login", "429 after 5", "src/auth/**");
  await commands.get("handoff.openContract")!();
  const { Ledger: L } = await import("../src/ledger.ts");
  const l = new L(lp);
  assert.ok(l.all().some((e) => e.action === "guardrail" && (e.payload as any).match.pattern === "db/migrations/**"));
  l.append({ actor: { kind: "ai", name: "claude-code" }, action: "file.edit", target: "src/billing/x.ts" });
  await commands.get("handoff.auditContract")!();
  assert.match(messages.at(-1)!, /drifting/);
  assert.match(messages.at(-1)!, /src\/billing\/x\.ts/);
});
import { rmSync } from "node:fs";
function rmSyncSafe(p: string) { try { rmSync(p); } catch {} }


test("extension: wake/sleep AIs with the two-awake rule, shown in the status bar and audited", async () => {
  writeFileSync(lp, ""); rmSyncSafe(lp);
  const { Registry } = await import("../src/providers.ts");
  const r = new Registry({ home: process.env.HANDOFF_HOME! });
  r.add({ name: "claude", kind: "anthropic", model: "m", keyEnv: "K" });
  r.add({ name: "local", kind: "ollama", model: "llama" });
  r.add({ name: "gem", kind: "gemini", model: "g", keyEnv: "G" });
  // quick pick returns the chosen item by index; role pick follows
  answers.push(0, 1); await commands.get("handoff.wakeAi")!();   // claude -> steward
  answers.push(1, 0); await commands.get("handoff.wakeAi")!();   // local -> editor
  assert.match(status.text, /editor local/); assert.match(status.text, /steward claude/);
  answers.push(2, 1); await commands.get("handoff.wakeAi")!();   // gem -> steward, claude sleeps
  assert.match(messages.at(-1)!, /claude went to sleep/);
  assert.match(status.text, /steward gem/); assert.doesNotMatch(status.text, /claude/);
  answers.push(0); await commands.get("handoff.sleepAi")!();     // first awake one (local) sleeps
  assert.doesNotMatch(status.text, /editor/);
  const acts = new (await import("../src/ledger.ts")).Ledger(lp).all().map((e) => e.action);
  assert.ok(acts.filter((a) => a === "provider.wake").length >= 3 && acts.includes("provider.sleep"));
});

test("extension: tell the steward what to do -> compiled prompt is opened, copied and queued; review prints", async () => {
  const { Ledger: L } = await import("../src/ledger.ts");
  const l = new L(lp);
  const { addGuardrail } = await import("../src/guardrails.ts");
  addGuardrail(l, { kind: "human", name: "t" }, "block", "Never edit migrations", { kind: "path", pattern: "db/**" });
  answers.push("add a retry to the payment call");
  await commands.get("handoff.dispatchTask")!();
  assert.match(clipboard, /GOAL: add a retry to the payment call/);
  assert.match(clipboard, /Never edit migrations/);
  assert.match(messages.at(-1)!, /Queued/);
  assert.ok(new L(lp).all().some((e) => e.action === "dispatch.approve"));
  commands.get("handoff.reviewProject")!();
  assert.ok(outLines.join("\n").length > 0);
});

test("extension: registering the MCP server writes configs that really start a working server", async () => {
  mkdirSync(join(root, ".vscode"), { recursive: true });
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  await commands.get("handoff.installMcp")!();
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers.other, "existing servers preserved");
  const vs = JSON.parse(readFileSync(join(root, ".vscode", "mcp.json"), "utf8"));
  assert.equal(vs.servers.handoff.type, "stdio");
  // launch exactly what the config says and talk MCP to it
  const { spawn } = await import("node:child_process");
  const e = vs.servers.handoff;
  const p = spawn(e.command, e.args, { stdio: ["pipe", "pipe", "inherit"] });
  const reply: any = await new Promise((ok) => { p.stdout.once("data", (d) => ok(JSON.parse(String(d).split("\n")[0]))); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n"); });
  p.kill();
  const names = reply.result.tools.map((t: any) => t.name);
  for (const n of ["get_brief", "check_action", "next_task", "find_technique"]) assert.ok(names.includes(n), n);
});

test("teardown", async () => { await ext.deactivate(); });
