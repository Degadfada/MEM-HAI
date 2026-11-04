import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";
import { compact, isArchivable, planCompaction, NOISE_TARGET } from "../src/compact.ts";
import { initProject } from "../src/init.ts";
import { tmpPath } from "./helpers.ts";

const me = { kind: "human" as const, name: "idahosa" };
const nobody = { kind: "unknown" as const, name: "unattributed" };

/* ---------------------------------------------------------------- incremental reads */

test("a shared handle picks up another writer's appends without re-reading the file", () => {
  const path = tmpPath();
  const a = new Ledger(path);
  a.append({ actor: me, action: "decision", summary: "first" });

  const shared = Ledger.open(path);
  assert.equal(shared.length, 1);

  // a different handle, standing in for another process
  new Ledger(path).append({ actor: me, action: "decision", summary: "second" });

  const again = Ledger.open(path);
  assert.equal(again.length, 2, "the append was picked up");
  assert.equal(again.all()[1]!.summary, "second");
  assert.equal(Ledger.verify(path).ok, true);
  Ledger.forget(path);
});

test("a rewritten file forces a full re-read rather than appending onto a stale chain", () => {
  const path = tmpPath();
  const l = new Ledger(path);
  for (let i = 0; i < 5; i++) l.append({ actor: me, action: "decision", summary: "e" + i });
  assert.equal(Ledger.open(path).length, 5);

  // repair re-chains in place: every later hash changes
  const broken = readFileSync(path, "utf8").split("\n").filter(Boolean);
  writeFileSync(path, broken.join("\n") + "\n" + broken[broken.length - 1] + "\n");
  Ledger.repair(path, me);

  const after = Ledger.open(path);
  assert.equal(Ledger.verify(path).ok, true, "chain intact after repair");
  assert.ok(after.length >= 6, "the shared handle re-read instead of trusting its cache");
  Ledger.forget(path);
});

test("a half-written final line is ignored until it is complete", () => {
  const path = tmpPath();
  const l = new Ledger(path);
  l.append({ actor: me, action: "decision", summary: "complete" });
  const shared = Ledger.open(path);
  assert.equal(shared.length, 1);

  // a writer mid-append: bytes present, no trailing newline
  writeFileSync(path, readFileSync(path, "utf8") + '{"type":"event","seq":1,"part', { flag: "w" });
  assert.equal(Ledger.open(path).length, 1, "the torn line was not parsed");
  Ledger.forget(path);
});

/* ---------------------------------------------------------------- compaction */

test("only unowned, unexplained, unapproved file churn is archivable", () => {
  const path = tmpPath();
  const l = new Ledger(path);

  const churn = l.append({ actor: nobody, action: "file.edit", target: "data/app.db", source: "vscode-watch" });
  const wal = l.append({ actor: nobody, action: "file.edit", target: "data/app.db-wal", source: "vscode-watch" });
  const source = l.append({ actor: nobody, action: "file.edit", target: "src/server.ts", source: "vscode-watch" });
  const owned = l.append({ actor: { kind: "ai", name: "claude-code" }, action: "file.edit", target: "data/app.db", source: "hook" });
  const explained = l.append({ actor: nobody, action: "file.edit", target: "data/app.db", rationale: { provenance: "declared", reason: "seeding fixtures" } });
  const approved = l.append({ actor: nobody, action: "file.edit", target: "data/app.db", approval: { status: "approved", by: "idahosa" } });
  const rule = l.append({ actor: me, action: "guardrail", summary: "no prod pushes" });

  assert.equal(isArchivable(churn, NOISE_TARGET), true);
  assert.equal(isArchivable(wal, NOISE_TARGET), true);
  assert.equal(isArchivable(source, NOISE_TARGET), false, "a source file is not churn");
  assert.equal(isArchivable(owned, NOISE_TARGET), false, "an AI owned it");
  assert.equal(isArchivable(explained, NOISE_TARGET), false, "it explains itself");
  assert.equal(isArchivable(approved, NOISE_TARGET), false, "you approved it");
  assert.equal(isArchivable(rule, NOISE_TARGET), false, "not a file action at all");
});

test("the plan is shown before anything moves, naming the noisiest targets", () => {
  const path = tmpPath();
  const l = new Ledger(path);
  for (let i = 0; i < 30; i++) l.append({ actor: nobody, action: "file.edit", target: "data/app.db", source: "vscode-watch" });
  for (let i = 0; i < 5; i++) l.append({ actor: nobody, action: "file.edit", target: "src/x.ts", source: "vscode-watch" });

  const plan = planCompaction(path);
  assert.equal(plan.total, 35);
  assert.equal(plan.archivable, 30);
  assert.equal(plan.keep, 5);
  assert.equal(plan.topTargets[0]!.target, "data/app.db");
  assert.equal(plan.topTargets[0]!.count, 30);
});

test("compaction archives rather than deletes, records itself, and leaves the chain intact", () => {
  const path = tmpPath();
  const l = new Ledger(path);
  l.append({ actor: me, action: "guardrail", summary: "keep me" });
  for (let i = 0; i < 20; i++) l.append({ actor: nobody, action: "file.edit", target: "data/app.db-wal", source: "vscode-watch" });
  l.append({ actor: { kind: "ai", name: "copilot" }, action: "file.edit", target: "src/a.ts", confidence: "inferred" });

  const before = readFileSync(path, "utf8");
  const r = compact(path, me);
  assert.equal(r.ok, true);
  assert.equal(r.archived, 20);
  assert.equal(r.kept, 2);

  // nothing was destroyed
  assert.ok(existsSync(r.archive), "the archive exists");
  assert.equal(readFileSync(r.backup, "utf8"), before, "the pre-compaction ledger is byte-identical");
  // The archive keeps each event's ORIGINAL seq and hash, so it can be matched line for line against
  // the preserved pre-compaction ledger. That is what makes it evidence. It is therefore NOT a valid
  // chain on its own -- re-chaining would destroy the hashes that tie it back.
  const archived = new Ledger(r.archive);
  assert.equal(archived.length, 20, "the archive is readable");
  const original = readFileSync(r.backup, "utf8");
  for (const e of archived.all()) assert.ok(original.includes(e.hash), "archived event " + e.id + " is matchable to the original by hash");

  // what remains is the record, plus the compaction event
  const after = new Ledger(path);
  assert.equal(Ledger.verify(path).ok, true, "chain intact");
  const kinds = after.all().map((e) => e.action);
  assert.ok(kinds.includes("guardrail"));
  assert.ok(kinds.includes("ledger.compact"), "the compaction is on the record");
  assert.ok(!after.all().some((e) => e.target === "data/app.db-wal"), "churn is gone from the working log");

  const rec = after.all().find((e) => e.action === "ledger.compact")!;
  assert.equal(rec.payload!.archived, 20);
  assert.equal(String(rec.payload!.originalSha256).length, 64);
  Ledger.forget(path);
});

test("compaction on a clean ledger changes nothing", () => {
  const path = tmpPath();
  const l = new Ledger(path);
  l.append({ actor: me, action: "decision", summary: "only real history here" });
  const before = readFileSync(path, "utf8");
  const r = compact(path, me);
  assert.equal(r.archived, 0);
  assert.match(r.note, /nothing to compact/);
  assert.equal(readFileSync(path, "utf8"), before, "the file was not touched");
});

/* ---------------------------------------------------------------- init */

test("init sets a project up in one go, and is safe to run twice", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const core = join(root, "fakecore");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "cli.js"), "// stand-in for the compiled core\n");

  const first = initProject({ root, home, ledgerFile: join(root, ".handoff", "ledger.jsonl"), coreDir: core });
  assert.equal(first.restartNeeded, true);

  const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
  assert.ok(JSON.stringify(settings.hooks).includes("claude-code-hook.mjs"), "the hook is wired");
  assert.ok(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.handoff, "MCP for Claude Code");
  assert.ok(JSON.parse(readFileSync(join(root, ".vscode", "mcp.json"), "utf8")).servers.handoff, "MCP for VS Code");
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.handoff\/$/m, "the ledger is gitignored");
  assert.equal(JSON.parse(readFileSync(join(home, "projects.json"), "utf8")).length, 1, "registered once");

  const second = initProject({ root, home, ledgerFile: join(root, ".handoff", "ledger.jsonl"), coreDir: core });
  assert.equal(second.restartNeeded, false, "nothing left to do");
  assert.equal(JSON.parse(readFileSync(join(home, "projects.json"), "utf8")).length, 1, "not registered twice");
  assert.equal(JSON.stringify(JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"))), JSON.stringify(settings), "hooks not duplicated");
});

test("init merges into existing settings instead of overwriting them", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2));
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");

  initProject({ root, home, ledgerFile: join(root, ".handoff", "ledger.jsonl") });

  const s = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.permissions.allow, ["Bash(npm test)"], "existing settings survive");
  assert.ok(JSON.stringify(s.hooks.PreToolUse).includes("echo mine"), "the existing hook survives");
  assert.ok(JSON.stringify(s.hooks.PreToolUse).includes("claude-code-hook.mjs"), "ours was added alongside");
  assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /node_modules\//, "existing ignores survive");
});

test("repair drops a byte-identical replay, but refuses to choose between conflicting twins", () => {
  // An exact replay carries nothing the first copy did not, so dropping it invents nothing.
  const dup = tmpPath();
  const a = new Ledger(dup);
  a.append({ actor: me, action: "decision", summary: "once" });
  const lines = readFileSync(dup, "utf8").split("\n").filter(Boolean);
  writeFileSync(dup, lines.join("\n") + "\n" + lines[lines.length - 1] + "\n");
  assert.equal(Ledger.verify(dup).ok, false);
  assert.equal(Ledger.repair(dup, me).ok, true);
  assert.equal(new Ledger(dup).all().filter((e) => e.summary === "once").length, 1);
  Ledger.forget(dup);

  // Two events sharing an id but differing in content is a real conflict. Picking one, or minting a
  // new id, would be inventing history -- so it refuses and names the id.
  const conflict = tmpPath();
  const b = new Ledger(conflict);
  b.append({ actor: me, action: "decision", summary: "original" });
  const l2 = readFileSync(conflict, "utf8").split("\n").filter(Boolean);
  const twin = { ...JSON.parse(l2[l2.length - 1]!), summary: "tampered" };
  writeFileSync(conflict, l2.join("\n") + "\n" + JSON.stringify(twin) + "\n");
  assert.throws(() => Ledger.repair(conflict, me), /different contents/);
  Ledger.forget(conflict);
});
