// One command to put a project under the ledger.
//
// This replaced a four-step dance: open the folder, run the hook installer, run the MCP installer,
// remember to gitignore the ledger, remember to register the project. Every step is idempotent and
// reports what it did, because a setup command that silently overwrites your settings is worse than
// no setup command.

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Projects } from "./projects.ts";

export interface InitOptions {
  root: string;
  home: string;
  ledgerFile: string;
  name?: string;
  /** Where the compiled core lives, to stage next to the hook. Defaults next to this module. */
  coreDir?: string;
}

export interface InitResult {
  log: string[];
  restartNeeded: boolean;
}

const HOOK_CMD = 'node "$CLAUDE_PROJECT_DIR/.handoff/claude-code-hook.mjs"';

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

export function initProject(o: InitOptions): InitResult {
  const root = resolve(o.root);
  const log: string[] = [];
  let changed = false;
  const did = (s: string) => { log.push("  + " + s); changed = true; };
  const already = (s: string) => log.push("  . " + s + " (already)");

  log.push(`Setting up ${root}`);

  // 1. the ledger and the hook runtime
  const hd = join(root, ".handoff");
  mkdirSync(hd, { recursive: true });
  // fileURLToPath, not URL.pathname: the latter leaves %20 in it, which breaks on any path with a
  // space in it -- such as a Windows home directory.
  const core = o.coreDir ?? dirname(fileURLToPath(import.meta.url));
  const hookSrc = [
    join(core, "..", "hooks", "claude-code-hook.mjs"), // running from src/ or dist/
    join(core, "claude-code-hook.mjs"),
    join(core, "..", "hook", "claude-code-hook.mjs"), // staged inside the extension
  ].find((p) => existsSync(p));
  if (!existsSync(join(hd, "core"))) {
    try { cpSync(core, join(hd, "core"), { recursive: true }); did("staged .handoff/core"); }
    catch { log.push("  ! could not stage .handoff/core; copy it yourself"); }
  } else already(".handoff/core");
  if (hookSrc && !existsSync(join(hd, "claude-code-hook.mjs"))) {
    writeFileSync(join(hd, "claude-code-hook.mjs"), readFileSync(hookSrc));
    did("staged the Claude Code hook");
  } else if (existsSync(join(hd, "claude-code-hook.mjs"))) already("the hook");
  if (!existsSync(join(hd, "package.json"))) writeFileSync(join(hd, "package.json"), '{"type":"module"}\n');

  // 2. the Claude Code hook, merged into whatever is already there
  const sp = join(root, ".claude", "settings.json");
  mkdirSync(dirname(sp), { recursive: true });
  const settings = existsSync(sp) ? readJson(sp) : {};
  settings.hooks = settings.hooks ?? {};
  let hookAdded = false;
  for (const [event, matcher] of [
    ["PreToolUse", "Edit|Write|MultiEdit|NotebookEdit|Bash"],
    ["PostToolUse", "Edit|Write|MultiEdit|NotebookEdit|Bash"],
    ["Notification", undefined],
  ] as const) {
    const arr = (settings.hooks[event] = settings.hooks[event] ?? []);
    if (JSON.stringify(arr).includes("claude-code-hook.mjs")) continue;
    arr.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: HOOK_CMD }] });
    hookAdded = true;
  }
  if (hookAdded) { writeFileSync(sp, JSON.stringify(settings, null, 2) + "\n"); did(".claude/settings.json hooks"); }
  else already(".claude/settings.json hooks");

  // 3. MCP, for Claude Code and for VS Code agent mode
  const args = (agent: string) => [".handoff/core/cli.js", "mcp", "--agent", agent, "--file", relative(root, resolve(o.ledgerFile)).split("\\").join("/") || ".handoff/ledger.jsonl"];
  const mcp = (file: string, key: string, entry: object, label: string) => {
    mkdirSync(dirname(file), { recursive: true });
    const j = existsSync(file) ? readJson(file) : {};
    if (j[key]?.handoff) return already(label);
    j[key] = { ...(j[key] ?? {}), handoff: entry };
    writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    did(label);
  };
  mcp(join(root, ".mcp.json"), "mcpServers", { command: "node", args: args("claude-code") }, ".mcp.json");
  mcp(join(root, ".vscode", "mcp.json"), "servers", { type: "stdio", command: "node", args: args("vscode-agent") }, ".vscode/mcp.json");

  // 4. keep the ledger out of git. It is local history, and it holds conversation excerpts.
  const gi = join(root, ".gitignore");
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!/^\.handoff\/?\s*$/m.test(cur)) {
    writeFileSync(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "\n# AI Handoff Ledger - local history and staged runtime\n.handoff/\n");
    did(".gitignore entry for .handoff/");
  } else already(".gitignore entry");

  // 5. put it on the machine-wide project list
  try {
    const P = new Projects(o.home);
    if (P.list.some((x) => x.root === root)) already("project registration");
    else {
      const base = (o.name ?? root.split(/[\\/]/).pop() ?? "project").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
      let name = base;
      for (let i = 2; P.list.some((x) => x.name === name); i++) name = `${base}-${i}`;
      P.add(name, root);
      did(`registered as "${name}"`);
    }
  } catch (e) {
    log.push(`  ! could not register the project: ${(e as Error).message}`);
  }

  return { log, restartNeeded: changed };
}
