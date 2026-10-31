import type { LedgerEvent } from "./types.ts";
import { sha256 } from "./canonical.ts";

export type FactKind =
  | "constraint" // hard rules from the human; never dropped
  | "denial" // human said no to an AI action
  | "decision"
  | "task"
  | "file"
  | "command"
  | "ai_switch"
  | "approval_pattern";

export interface Fact {
  id: string; // stable: hash of kind+key
  kind: FactKind;
  key: string; // identity within kind (topic, path, task name)
  text: string; // one line, human readable
  hard: boolean; // must survive any budget
  sources: string[]; // event ids that justify this fact (traceability)
  firstSeq: number;
  lastSeq: number;
  count: number; // how many events fed this fact
  aspects: string[]; // coverage aspects, used by the distiller
}

const mk = (kind: FactKind, key: string): string => sha256(kind + "\0" + key).slice(0, 12);
const who = (e: LedgerEvent) => `${e.actor.kind === "ai" ? "AI " : ""}${e.actor.name}`;
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Rederive facts from the RAW event log every time (never summarize a summary).
 * Events that were reversed are dropped: a reversal is a negative update.
 */
export function extractFacts(events: readonly LedgerEvent[]): Fact[] {
  const reversed = new Set(events.filter((e) => e.reverses).map((e) => e.reverses!));
  const live = events.filter((e) => e.delta === 1 && !reversed.has(e.id));
  const facts = new Map<string, Fact>();

  const upsert = (kind: FactKind, key: string, text: string, e: LedgerEvent, hard: boolean, aspects: string[], replace = true) => {
    const id = mk(kind, key);
    const f = facts.get(id);
    if (f) {
      if (replace) f.text = text;
      f.hard = f.hard || hard;
      f.sources.push(e.id);
      f.lastSeq = e.seq;
      f.count++;
      for (const a of aspects) if (!f.aspects.includes(a)) f.aspects.push(a);
    } else
      facts.set(id, { id, kind, key, text, hard, sources: [e.id], firstSeq: e.seq, lastSeq: e.seq, count: 1, aspects: [`kind:${kind}`, ...aspects] });
  };

  const approvals = new Map<string, { approved: number; denied: number }>();

  for (const e of live) {
    const t = e.target ?? "";
    const s = oneLine(e.summary ?? "");
    const ap = e.approval.status;

    if (e.actor.kind === "ai" && (ap === "approved" || ap === "denied")) {
      const k = e.action;
      const a = approvals.get(k) ?? { approved: 0, denied: 0 };
      a[ap]++;
      approvals.set(k, a);
    }

    switch (e.action) {
      case "constraint":
        upsert("constraint", s || t, `RULE: ${s || t}`, e, true, [`topic:${t || s.slice(0, 24)}`]);
        break;
      case "decision":
        upsert("decision", t || s, `Decision${t ? ` (${t})` : ""}: ${s}`, e, false, [`topic:${t || s.slice(0, 24)}`]);
        break;
      case "task.open":
        upsert("task", t || s, `OPEN TASK: ${t || s}${s && t ? ` — ${s}` : ""}`, e, false, [`topic:${t || s.slice(0, 24)}`]);
        break;
      case "task.done":
        facts.delete(mk("task", t || s));
        break;
      case "ai.switch":
        upsert("ai_switch", `${e.seq}`, `Switched to ${e.aiInUse ?? t} (by ${who(e)})`, e, false, ["topic:ai-switch"]);
        break;
      case "file.edit":
      case "file.create":
      case "file.delete": {
        const verb = e.action.split(".")[1]!;
        upsert("file", t, `${t}: last ${verb} by ${who(e)}${e.aiInUse && e.aiInUse !== e.actor.name ? ` via ${e.aiInUse}` : ""}${ap === "approved" ? " (approved)" : ap === "denied" ? " (DENIED)" : ""}${s ? ` — ${s}` : ""}`, e, false, [`dir:${dirOf(t)}`, `file:${t}`]);
        break;
      }
      case "command.run":
        upsert("command", s || t, `Ran: ${t || s}${s && t ? ` — ${s}` : ""} (${who(e)}${ap === "approved" ? ", approved" : ap === "denied" ? ", DENIED" : ""})`, e, false, [`topic:commands`]);
        break;
      case "refused":
      case "guardrail.blocked":
      case "contract.accept":
      case "ai.usage":
      case "provider.wake":
      case "provider.sleep":
      case "dispatch":
      case "dispatch.approve":
      case "dispatch.taken":
      case "dispatch.done":
      case "learn.outcome":
        break; // refused -> denial fact below; the others are evidence, not facts
      case "guardrail": {
        const lvl = (e.payload as { level?: string } | undefined)?.level === "advise" ? "advise" : "BLOCKED";
        upsert("constraint", `g:${e.id}`, `GUARDRAIL (${lvl === "BLOCKED" ? "enforced where possible" : "advisory"}): ${s}`, e, true, [`topic:guardrails`]);
        break;
      }
      case "contract.open": {
        const p = (e.payload ?? {}) as { acceptance?: string[]; inScope?: string[]; outOfScope?: string[] };
        const acc = (p.acceptance ?? []).length ? ` Done when: ${(p.acceptance ?? []).join("; ")}.` : "";
        const sc = (p.inScope ?? []).length ? ` Only touch: ${(p.inScope ?? []).join(", ")}.` : "";
        const ox = (p.outOfScope ?? []).length ? ` Never touch: ${(p.outOfScope ?? []).join(", ")}.` : "";
        upsert("task", `contract:${t}`, `CONTRACT ${t}: ${s}.${acc}${sc}${ox}`, e, false, [`topic:contract:${t}`]);
        break;
      }
      case "contract.close":
        facts.delete(mk("task", `contract:${t}`));
        break;
      default:
        if (s) upsert("decision", `${e.action}:${t}`, `${e.action}${t ? ` ${t}` : ""}: ${s}`, e, false, [`topic:${e.action}`]);
    }

    if (ap === "denied" && e.action !== "constraint" && e.action !== "guardrail.blocked")
      upsert("denial", `${e.action}:${t || s}`, `Human DENIED ${who(e)}: ${e.action} ${t || s}`.trim(), e, true, [`topic:denials`]);
  }

  // Approval behaviour per action type: tells the next AI how much autonomy the human gives.
  for (const [action, a] of approvals) {
    const total = a.approved + a.denied;
    if (total < 3) continue;
    const e = live[live.length - 1]!;
    const rate = Math.round((100 * a.approved) / total);
    const id = mk("approval_pattern", action);
    facts.set(id, {
      id, kind: "approval_pattern", key: action,
      text: `Human approves AI "${action}" ${rate}% of the time (${a.approved}/${total})`,
      hard: false, sources: live.filter((x) => x.action === action && (x.approval.status === "approved" || x.approval.status === "denied")).map((x) => x.id).slice(-5),
      firstSeq: 0, lastSeq: e.seq, count: total, aspects: ["kind:approval_pattern", `topic:approval:${action}`],
    });
  }

  return [...facts.values()].sort((a, b) => a.firstSeq - b.firstSeq);
}
