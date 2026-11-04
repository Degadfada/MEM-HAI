"use strict";
// VS Code extension: thin adapter over the handoff core (ESM, loaded with dynamic import).
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");

const IGNORE = /(^|[\\/])(\.git|node_modules|\.handoff|dist|out|build|\.next|\.venv|__pycache__|\.vscode-test|coverage)([\\/]|$)/;
// Churn that is a side effect of tooling, not work anybody did: lock files, journals, build stamps.
// A running app rewrites its database thousands of times an hour: that is the app working, not
// anybody doing work, and left in it drowns the real record. Measured on one project, 12,230 of
// 13,136 events were one SQLite file and its write-ahead log.
const NOISE = /(\.(lock|log|tmp|swp|pyc|vsix|db|sqlite|sqlite3|git)$|-(wal|shm|journal)$|(^|[\\/])(\.DS_Store|Thumbs\.db)$)/i;
const AI_RECENT_MS = 5000; // a hook-logged AI change to the same file within this window claims the file event

let core; // { Ledger, makeBrief, buildVerifiedBrief, startServer, FILENAME }
let ledger, root, ledgerFile, statusItem, dash;
const timers = new Map();
const savedByHuman = new Map(); // path -> ts

async function loadCore(ctx) {
  const dir = path.join(ctx.extensionPath, "core");
  const imp = (f) => import(pathToFileURL(path.join(dir, f)).href);
  const [l, h, v, s, g, sc, pr, st, kn, se, pj] = await Promise.all([imp("ledger.js"), imp("handoff.js"), imp("verify.js"), imp("server.js"), imp("guardrails.js"), imp("scope.js"), imp("providers.js"), imp("steward.js"), imp("knowledge.js"), imp("sessions.js"), imp("projects.js")]);
  return { Projects: pj.Projects, dayIndex: se.dayIndex, dayReport: se.dayReport, humanDuration: se.humanDuration, localDay: se.localDay, Registry: pr.Registry, dispatch: st.dispatch, review: st.review, KnowledgeStore: kn.KnowledgeStore, addGuardrail: g.addGuardrail, openContract: sc.openContract, liveContracts: sc.liveContracts, audit: sc.audit, Ledger: l.Ledger, makeBrief: h.makeBrief, FILENAME: h.FILENAME, buildVerifiedBrief: v.buildVerifiedBrief, startServer: s.startServer };
}

const cfg = () => vscode.workspace.getConfiguration("handoff");
const humanName = () => cfg().get("humanName") || os.userInfo().username;
const homeDir = () => cfg().get("home") || process.env.HANDOFF_HOME || path.join(os.homedir(), ".handoff");
const registry = () => new core.Registry({ home: homeDir() });
const open = () => new core.Ledger(ledgerFile); // reopen each time: hooks in other processes append to the same file

function currentAi() {
  const l = open();
  const ev = l.all();
  for (let i = ev.length - 1; i >= 0; i--) if (ev[i].aiInUse && ev[i].delta === 1 && !l.isReversed(ev[i].id)) return ev[i].aiInUse;
  return null;
}

function refreshStatus() {
  if (!statusItem) return;
  try {
    const ai = currentAi();
    let extra = "";
    try { const r = registry(); const ed = r.holder("editor"), stw = r.holder("steward"); extra = (ed ? ` · editor ${ed.name}` : "") + (stw ? ` · steward ${stw.name}` : ""); } catch {}
    statusItem.text = `$(history) ${ai || "no AI"}${extra}`;
    statusItem.tooltip = "AI Handoff Ledger — click to switch AI";
  } catch (e) { statusItem.text = "$(warning) handoff"; statusItem.tooltip = String(e.message || e); }
}

function logFileEvent(action, absPath, source, actor, confidence) {
  const rel = path.relative(root, absPath).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || IGNORE.test(rel) || NOISE.test(rel)) return;
  // A directory whose mtime moved is not work: it is the parent of something we already logged.
  try { if (fs.statSync(absPath).isDirectory()) return; } catch { /* gone: a delete, keep it */ }
  const l = open();
  // Was this already attributed to an AI by a hook moments ago? Then don't double count.
  const now = Date.now();
  for (let i = l.all().length - 1; i >= 0 && i > l.all().length - 15; i--) {
    const e = l.all()[i];
    if (now - Date.parse(e.ts) > AI_RECENT_MS) break;
    if (e.target === rel && e.actor.kind === "ai") return;
  }
  l.append({ actor, confidence, aiInUse: currentAi() || undefined, action, target: rel, source });
  refreshStatus();
}

/**
 * A change nobody claimed. If you have declared which AI you are driving, attribute it to that AI and
 * mark the attribution `inferred`: we did not watch it act, we deduced it from what you said is awake.
 * With no AI declared it stays `unattributed`, because a deduction needs something to deduce from.
 */
function attributeUnclaimed(action, absPath) {
  const ai = currentAi();
  if (ai) return logFileEvent(action, absPath, "vscode-watch", { kind: "ai", name: ai }, "inferred");
  return logFileEvent(action, absPath, "vscode-watch", { kind: "unknown", name: "unattributed" }, "unattributed");
}

function onFsEvent(action, uri) {
  const p = uri.fsPath;
  clearTimeout(timers.get(p));
  timers.set(p, setTimeout(() => {
    timers.delete(p);
    try {
      const savedAt = savedByHuman.get(p);
      if (savedAt && Date.now() - savedAt < 3000) return; // the save listener already logged it as human
      attributeUnclaimed(action, p);
    } catch (e) { console.error("handoff:", e); }
  }, 800));
}

async function ask(prompt, placeHolder) {
  return vscode.window.showInputBox({ prompt, placeHolder, ignoreFocusOut: true });
}

async function switchAi() {
  const known = cfg().get("knownAis") || [];
  const pick = await vscode.window.showQuickPick([...known, "other…"], { placeHolder: "Which AI are you moving to?" });
  if (!pick) return;
  const to = pick === "other…" ? await ask("Name of the AI") : pick;
  if (!to) return;
  const target = await vscode.window.showQuickPick(
    [{ label: "CLAUDE.md", id: "claude-md" }, { label: "AGENTS.md", id: "agents-md" }, { label: "System prompt (copy to clipboard)", id: "system-prompt" }, { label: "MCP JSON", id: "mcp-json" }],
    { placeHolder: "Where should the memory go?" });
  if (!target) return;
  const l = open();
  l.append({ actor: { kind: "human", name: humanName() }, action: "ai.switch", aiInUse: to, summary: `switched to ${to}`, source: "vscode" });
  const res = await core.buildVerifiedBrief(l, to, target.id);
  const m = res.brief.metrics;
  if (target.id === "system-prompt") {
    await vscode.env.clipboard.writeText(res.brief.text);
  } else {
    const file = path.join(root, core.FILENAME[target.id]);
    if (fs.existsSync(file) && !(await vscode.window.showWarningMessage(`${path.basename(file)} exists. Overwrite?`, { modal: true }, "Overwrite"))) return;
    fs.writeFileSync(file, res.brief.text);
  }
  refreshStatus();
  const v = res.report;
  vscode.window.showInformationMessage(
    `${v.pass ? "Verified" : "NOT fully verified"}: ${m.briefTokens} tokens from ${m.rawTokens} (${m.compressionRatio.toFixed(1)}x). Hard rules ${m.hardKept}/${m.hardTotal}. ${target.id === "system-prompt" ? "Copied to clipboard." : "Written to " + core.FILENAME[target.id] + "."}`);
}

async function simple(action, promptText, withTarget, extra) {
  const text = await ask(promptText);
  if (!text) return;
  const target = withTarget ? await ask(withTarget + " (optional)") : undefined;
  open().append({ actor: { kind: "human", name: humanName() }, action, summary: text, target: target || undefined, aiInUse: currentAi() || undefined, source: "vscode", ...(extra || {}) });
  vscode.window.showInformationMessage("Recorded.");
}

async function installClaudeHook(ctx) {
  const dest = path.join(root, ".handoff");
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(ctx.extensionPath, "core"), path.join(dest, "core"), { recursive: true });
  fs.copyFileSync(path.join(ctx.extensionPath, "hook", "claude-code-hook.mjs"), path.join(dest, "claude-code-hook.mjs"));
  fs.writeFileSync(path.join(dest, "package.json"), '{"type":"module"}\n');
  const settingsPath = path.join(root, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  let s = {};
  if (fs.existsSync(settingsPath)) s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  s.hooks = s.hooks || {};
  const cmd = 'node "$CLAUDE_PROJECT_DIR/.handoff/claude-code-hook.mjs"';
  const add = (event, matcher) => {
    const arr = (s.hooks[event] = s.hooks[event] || []);
    if (!JSON.stringify(arr).includes("claude-code-hook.mjs")) arr.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd }] });
  };
  add("PreToolUse", "Edit|Write|MultiEdit|NotebookEdit|Bash");
  add("PostToolUse", "Edit|Write|MultiEdit|NotebookEdit|Bash");
  add("Notification");
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
  vscode.window.showInformationMessage("Claude Code hook installed in .claude/settings.json. Restart Claude Code to pick it up.");
}

async function addGuardrailCmd() {
  const text = await ask("Rule in plain words (what the AI must not do)");
  if (!text) return;
  const kind = await vscode.window.showQuickPick([{ label: "A command (regex)", id: "command" }, { label: "A file path (glob)", id: "path" }, { label: "An action (e.g. file.delete)", id: "action" }], { placeHolder: "What does the rule match?" });
  if (!kind) return;
  const pattern = await ask("Pattern", kind.id === "command" ? "git\\s+push\\s+.*--force" : kind.id === "path" ? "**/.env*" : "file.delete");
  if (!pattern) return;
  const level = await vscode.window.showQuickPick([{ label: "Block (enforced where we can)", id: "block" }, { label: "Advise (told to every AI, not blocked)", id: "advise" }], { placeHolder: "How strict?" });
  if (!level) return;
  core.addGuardrail(open(), { kind: "human", name: humanName() }, level.id, text, { kind: kind.id, pattern });
  vscode.window.showInformationMessage("Guardrail added.");
}

async function openContractCmd() {
  const id = await ask("Short id (lowercase, dashes)", "rate-limit-login");
  if (!id) return;
  const goal = await ask("Goal: what is to be done?");
  if (!goal) return;
  const acc = await ask("Done when (separate with ;)", "returns 429 after 5 tries; test added");
  const inScope = await ask("Only touch these paths (globs, separate with ;) — empty = anywhere", "src/auth/**; test/auth/**");
  const split = (x) => (x ? x.split(";").map((y) => y.trim()).filter(Boolean) : []);
  core.openContract(open(), { kind: "human", name: humanName() }, { id, goal, acceptance: split(acc), inScope: split(inScope) });
  vscode.window.showInformationMessage(`Contract ${id} opened.`);
}

async function auditContractCmd() {
  const cs = core.liveContracts(open());
  if (!cs.length) return vscode.window.showInformationMessage("No open contracts.");
  const pick = cs.length === 1 ? cs[0].id : await vscode.window.showQuickPick(cs.map((c) => c.id), { placeHolder: "Which contract?" });
  if (!pick) return;
  const a = core.audit(open(), pick);
  const show = a.verdict === "drifting" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  show(a.text, { modal: false });
}

function stewardDeps() {
  const r = registry();
  return {
    ledger: open(), home: homeDir(), knowledge: new core.KnowledgeStore(path.join(homeDir(), "knowledge")),
    ask: r.holder("steward") ? async (system, prompt) => (await r.askSteward({ system, prompt, maxTokens: 700 })).text : undefined,
  };
}

async function wakeAi() {
  const r = registry();
  if (!r.providers.length) return vscode.window.showInformationMessage('No AIs plugged in yet. Add one in a terminal: handoff providers add --name claude --kind anthropic --model <model> --key-env ANTHROPIC_API_KEY');
  const pick = await vscode.window.showQuickPick(r.providers.map((p) => ({ label: p.name, description: `${p.kind}/${p.model} · ${p.role}`, p })), { placeHolder: "Which AI should wake up?" });
  if (!pick) return;
  const role = await vscode.window.showQuickPick([{ label: "Editor (the one working in VS Code)", id: "editor" }, { label: "Steward (the helper that guards scope and writes prompts)", id: "steward" }], { placeHolder: "As which role?" });
  if (!role) return;
  const out = r.wake(pick.label, role.id);
  open().append({ actor: { kind: "human", name: humanName() }, action: "provider.wake", summary: `${out.woke} awake as ${role.id}${out.slept.length ? `; ${out.slept.join(", ")} put to sleep` : ""}`, source: "vscode" });
  refreshStatus();
  vscode.window.showInformationMessage(`${out.woke} is now the ${role.id}.${out.slept.length ? ` ${out.slept.join(", ")} went to sleep.` : ""}`);
}

async function sleepAi() {
  const r = registry();
  const awake = r.awake();
  if (!awake.length) return vscode.window.showInformationMessage("Everything is already asleep.");
  const pick = await vscode.window.showQuickPick(awake.map((p) => ({ label: p.name, description: p.role })), { placeHolder: "Put which AI to sleep?" });
  if (!pick) return;
  r.sleep(pick.label);
  open().append({ actor: { kind: "human", name: humanName() }, action: "provider.sleep", summary: `${pick.label} put to sleep`, source: "vscode" });
  refreshStatus();
}

async function dispatchTask() {
  const task = await ask("What should the AI do? (the steward turns this into a short, rule-aware prompt)");
  if (!task) return;
  const cs = core.liveContracts(open());
  const contract = cs.length ? await vscode.window.showQuickPick([{ label: "(no contract)", id: undefined }, ...cs.map((c) => ({ label: c.id, description: c.goal, id: c.id }))], { placeHolder: "Attach a contract?" }) : undefined;
  const r = await core.dispatch(stewardDeps(), { kind: "human", name: humanName() }, task, { contract: contract && contract.id, source: "local" });
  await vscode.env.clipboard.writeText(r.compiled.prompt);
  const doc = await vscode.workspace.openTextDocument({ content: r.compiled.prompt, language: "markdown" });
  await vscode.window.showTextDocument(doc, { preview: true });
  vscode.window.showInformationMessage(`Queued (${r.compiled.arm}, ${r.compiled.tokens} tokens from ${r.compiled.sourceTokens}${r.compiled.via === "llm" ? ", compressed by the steward" : ""}). Prompt copied; MCP-connected AIs can also pull it with next_task.`);
}

function reviewProject() {
  const r = core.review(stewardDeps());
  const out = (reviewChannel = reviewChannel || vscode.window.createOutputChannel("Handoff review"));
  out.clear(); out.appendLine(r.text); out.show(true);
}
let reviewChannel;

function installMcp(ctx) {
  const dest = path.join(root, ".handoff");
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(ctx.extensionPath, "core"), path.join(dest, "core"), { recursive: true });
  const cli = path.join(dest, "core", "cli.js");
  const args = (agent) => [cli, "mcp", "--agent", agent, "--file", ledgerFile, "--home", homeDir()];
  const merge = (file, key, entry) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let j = {};
    if (fs.existsSync(file)) j = JSON.parse(fs.readFileSync(file, "utf8"));
    j[key] = { ...(j[key] || {}), handoff: entry };
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
  };
  merge(path.join(root, ".mcp.json"), "mcpServers", { command: "node", args: args("claude-code") });          // Claude Code
  merge(path.join(root, ".vscode", "mcp.json"), "servers", { type: "stdio", command: "node", args: args("vscode-agent") }); // VS Code agent mode / Copilot
  vscode.window.showInformationMessage("MCP server registered for this workspace (.mcp.json for Claude Code, .vscode/mcp.json for VS Code agent mode). Reload the window to pick it up.");
}

/**
 * Put this folder on the machine-wide project list, so the dashboard can show every project that has
 * memory without you running a command for each one. Idempotent, and never fatal: a name clash or an
 * unwritable home should not stop the extension from loading.
 */
function autoRegisterProject() {
  try {
    const P = new core.Projects(homeDir());
    if (P.list.some((p) => p.root === root)) return;
    // Project names are lowercase letters, digits, - and _ only.
    const base = path.basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
    let name = base;
    for (let i = 2; P.list.some((p) => p.name === name); i++) name = base + "-" + i;
    P.add(name, root);
  } catch (e) { console.error("handoff: could not register project:", e && e.message); }
}

async function showHistory() {
  const l = open();
  const days = core.dayIndex(l.all());
  if (!days.length) return vscode.window.showInformationMessage("No history recorded yet.");

  const pick = await vscode.window.showQuickPick(
    days.map((d) => ({
      label: d.date,
      description: d.events + " action(s)",
      detail: (d.ais.length ? d.ais : d.actors).join(", "),
      date: d.date,
    })),
    { title: "Which day?", placeHolder: "Pick a day to replay" },
  );
  if (!pick) return;

  const r = core.dayReport(l.all(), pick.date, { isReversed: (id) => l.isReversed(id) });
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const out = [];
  out.push("# " + r.date);
  out.push("");
  out.push(r.events + " action(s) in " + r.sessions.length + " session(s).");
  out.push("");
  out.push("## Who worked");
  out.push("");
  out.push("| who | time | sessions | actions | files |");
  out.push("| --- | --- | --- | --- | --- |");
  for (const a of r.byAi)
    out.push("| " + a.name + " | " + core.humanDuration(a.durationMs) + " | " + a.sessions + " | " + a.events + " | " + a.files + " |");
  out.push("");
  out.push("## Sessions");
  for (const sx of r.sessions) {
    out.push("");
    out.push("### " + sx.actor.name + (sx.aiInUse && sx.actor.kind !== "ai" ? " (via " + sx.aiInUse + ")" : ""));
    out.push("");
    out.push("- " + clock(sx.start) + " to " + clock(sx.end) + " — " + core.humanDuration(sx.durationMs) +
             (sx.observed === "single-event" ? " (one action, no span)" : ""));
    out.push("- " + Object.entries(sx.actions).map(([k, n]) => k + " x" + n).join(", "));
    const mix = Object.entries(sx.confidence).filter(([, n]) => n > 0).map(([k, n]) => k + " " + n).join(", ");
    out.push("- attribution: " + mix);
    if (sx.files.length) {
      out.push("- files:");
      for (const f of sx.files) out.push("  - `" + f + "`");
    }
    if (sx.commands.length) {
      out.push("- commands:");
      for (const c of sx.commands.slice(0, 20)) out.push("  - `" + c.slice(0, 160) + "`");
    }
    if (sx.reversed) out.push("- **" + sx.reversed + " of these were later undone**");
  }
  out.push("");
  out.push("---");
  out.push("");
  out.push("Attribution across the day: " + r.confidence.exact + " exact, " + r.confidence.inferred +
           " inferred, " + r.confidence.unattributed + " unattributed.");
  out.push("");
  out.push("_exact_ = the AI named itself through a hook or MCP. _inferred_ = the file changed while that AI was");
  out.push("declared in use. _unattributed_ = nobody claimed it and it was not guessed.");

  const doc = await vscode.workspace.openTextDocument({ content: out.join("\n"), language: "markdown" });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function openDashboard() {
  if (!dash) dash = await core.startServer({ ledgerPath: ledgerFile, projectRoot: root, home: homeDir() });
  await vscode.env.openExternal(vscode.Uri.parse(dash.url));
}

function verifyLedger() {
  const r = core.Ledger.verify(ledgerFile);
  if (r.ok) vscode.window.showInformationMessage(`Ledger intact: ${r.events} events.`);
  else vscode.window.showErrorMessage(`Ledger FAILED at line ${r.atLine}: ${r.error}`);
}

async function doneTask() {
  const ev = open().all();
  const done = new Set(ev.filter((e) => e.action === "task.done").map((e) => e.target));
  const names = [...new Set(ev.filter((e) => e.action === "task.open" && !done.has(e.target)).map((e) => e.target))];
  if (!names.length) return vscode.window.showInformationMessage("No open tasks.");
  const pick = await vscode.window.showQuickPick(names, { placeHolder: "Which task is done?" });
  if (pick) open().append({ actor: { kind: "human", name: humanName() }, action: "task.done", target: pick, source: "vscode" });
}

async function activate(ctx) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return;
  root = folder.uri.fsPath;
  ledgerFile = path.resolve(root, cfg().get("ledgerPath") || ".handoff/ledger.jsonl");
  core = await loadCore(ctx);
  open(); // creates the ledger if missing

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = "handoff.switchAi";
  statusItem.show();
  refreshStatus();

  const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, (...a) => Promise.resolve(fn(...a)).catch((e) => vscode.window.showErrorMessage("Handoff: " + (e.message || e)))));
  reg("handoff.switchAi", switchAi);
  reg("handoff.recordDecision", () => simple("decision", "What did you decide?", "Topic"));
  reg("handoff.addRule", () => simple("constraint", "Rule the AI must never break"));
  reg("handoff.addTask", () => simple("task.open", "What needs doing?", "Short task name"));
  reg("handoff.doneTask", doneTask);
  reg("handoff.recordRefusal", () => simple("refused", "What AI action did you refuse?", null, { actor: { kind: "ai", name: currentAi() || "ai" }, approval: { status: "denied", by: humanName(), at: new Date().toISOString() } }));
  reg("handoff.addGuardrail", addGuardrailCmd);
  reg("handoff.openContract", openContractCmd);
  reg("handoff.auditContract", auditContractCmd);
  reg("handoff.wakeAi", wakeAi);
  reg("handoff.sleepAi", sleepAi);
  reg("handoff.dispatchTask", dispatchTask);
  reg("handoff.reviewProject", reviewProject);
  reg("handoff.installMcp", () => installMcp(ctx));
  autoRegisterProject();
  reg("handoff.showHistory", showHistory);
  reg("handoff.openDashboard", openDashboard);
  reg("handoff.installClaudeHook", () => installClaudeHook(ctx));
  reg("handoff.verifyLedger", verifyLedger);

  // The human saving a file in the editor is attributable to the human.
  ctx.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme !== "file" || !cfg().get("watchFiles")) return;
    savedByHuman.set(doc.uri.fsPath, Date.now());
    try { logFileEvent("file.edit", doc.uri.fsPath, "vscode-save", { kind: "human", name: humanName() }, "exact"); } catch (e) { console.error("handoff:", e); }
  }));
  if (cfg().get("watchFiles")) {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
    w.onDidCreate((u) => onFsEvent("file.create", u));
    w.onDidChange((u) => onFsEvent("file.edit", u));
    w.onDidDelete((u) => onFsEvent("file.delete", u));
    ctx.subscriptions.push(w);
  }
  ctx.subscriptions.push({ dispose: () => dash && dash.close() }, statusItem);
  return { _test: { logFileEvent, attributeUnclaimed, showHistory, autoRegisterProject, currentAi, switchAi, installClaudeHook, openDashboard } };
}

function deactivate() { if (dash) return dash.close(); }
module.exports = { activate, deactivate };
