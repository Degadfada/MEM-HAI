import type { Ledger } from "./ledger.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type Level = "block" | "advise";
export interface Match {
  kind: "command" | "path" | "action";
  pattern: string; // command: regex source; path: glob; action: exact action name
}
export interface Guardrail {
  id: string; // the ledger event id that created it; reversing that event revokes it
  level: Level;
  text: string;
  match: Match;
}
export interface Attempt {
  action: string; // file.edit | file.create | file.delete | command.run | ...
  target?: string; // path or command text
}
export interface Verdict {
  allowed: boolean; // false only if a `block` rule matched
  violations: Guardrail[];
}

/** glob -> regex. `**` crosses folders, `*` does not, `?` is one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function validateMatch(m: Match): string | null {
  if (!m || !["command", "path", "action"].includes(m.kind)) return "match.kind must be command, path or action";
  if (typeof m.pattern !== "string" || !m.pattern || m.pattern.length > 200) return "match.pattern required, max 200 chars";
  if (m.kind === "command") {
    try { new RegExp(m.pattern, "i"); } catch { return "match.pattern is not a valid regular expression"; }
    // reject the classic catastrophic shapes: nested quantifiers like (a+)+ or (.*)*
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(m.pattern)) return "match.pattern has nested quantifiers (ReDoS risk)";
  }
  return null;
}

export function matches(g: Guardrail, a: Attempt): boolean {
  const t = a.target ?? "";
  switch (g.match.kind) {
    case "action": return a.action === g.match.pattern;
    case "command": return a.action === "command.run" && new RegExp(g.match.pattern, "i").test(t);
    case "path": return a.action.startsWith("file.") && globToRegExp(g.match.pattern).test(normPath(t));
  }
}

export function evaluate(rules: readonly Guardrail[], a: Attempt): Verdict {
  const violations = rules.filter((r) => matches(r, a));
  return { allowed: !violations.some((v) => v.level === "block"), violations };
}

export const defaultHome = () => process.env.HANDOFF_HOME || join(homedir(), ".handoff");

/** Rules that apply to EVERY project on this machine. Stored in <home>/guardrails.json (not in any one ledger). */
export function loadGlobalGuardrails(home: string): Guardrail[] {
  try {
    const arr = JSON.parse(readFileSync(join(home, "guardrails.json"), "utf8")) as Guardrail[];
    return arr.filter((g) => g && !validateMatch(g.match) && typeof g.text === "string").map((g) => ({ ...g, level: g.level === "advise" ? "advise" : "block" }));
  } catch { return []; }
}
export function addGlobalGuardrail(home: string, level: Level, text: string, match: Match): Guardrail {
  const err = validateMatch(match);
  if (err) throw new Error(err);
  if (!text.trim()) throw new Error("text required");
  mkdirSync(home, { recursive: true });
  const all = existsSync(join(home, "guardrails.json")) ? (JSON.parse(readFileSync(join(home, "guardrails.json"), "utf8")) as Guardrail[]) : [];
  const g: Guardrail = { id: "global:" + (all.length + 1) + "-" + Date.now().toString(36), level, text, match };
  writeFileSync(join(home, "guardrails.json"), JSON.stringify([...all, g], null, 2));
  return g;
}
export function removeGlobalGuardrail(home: string, id: string) {
  const all = loadGlobalGuardrails(home);
  if (!all.some((g) => g.id === id)) throw new Error(`no such global guardrail ${id}`);
  writeFileSync(join(home, "guardrails.json"), JSON.stringify(all.filter((g) => g.id !== id), null, 2));
}

/** Live guardrails = guardrail events nobody reversed (the ledger is the store) + machine-wide rules when `home` is given. */
export function liveGuardrails(l: Ledger, home?: string): Guardrail[] {
  const out: Guardrail[] = home ? loadGlobalGuardrails(home) : [];
  for (const e of l.all()) {
    if (e.action !== "guardrail" || e.delta !== 1 || l.isReversed(e.id)) continue;
    const p = e.payload as { level?: Level; match?: Match } | undefined;
    if (!p?.match || validateMatch(p.match)) continue; // a corrupt rule is skipped, never crashes enforcement
    out.push({ id: e.id, level: p.level === "advise" ? "advise" : "block", text: e.summary ?? "", match: p.match });
  }
  return out;
}

export function addGuardrail(l: Ledger, by: { kind: "human"; name: string }, level: Level, text: string, match: Match, source = "manual") {
  const err = validateMatch(match);
  if (err) throw new Error(err);
  if (!text.trim()) throw new Error("text required");
  return l.append({ actor: by, action: "guardrail", summary: text, payload: { level, match }, source });
}

/** Records that a rule stopped an attempt (so the dashboard and the steward can see it). */
export function logBlocked(l: Ledger, actor: { kind: "ai"; name: string }, a: Attempt, v: Verdict, source: string) {
  return l.append({ actor, action: "guardrail.blocked", target: a.target, summary: `${a.action} refused by: ${v.violations.map((x) => x.text).join("; ")}`, payload: { rules: v.violations.map((x) => x.id), attempted: a.action }, source, approval: { status: "denied", by: "guardrail" } });
}
