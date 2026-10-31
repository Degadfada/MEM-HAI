import type { Ledger } from "./ledger.ts";
import type { LedgerEvent } from "./types.ts";
import { globToRegExp } from "./guardrails.ts";

export interface Contract {
  id: string; // short slug chosen by the human, e.g. "rate-limit-login"
  goal: string;
  acceptance: string[];
  inScope: string[]; // path globs; empty = everything not excluded
  outOfScope: string[];
  openedSeq: number;
  openEventId: string;
}

export interface Audit {
  contract: Contract;
  closed: boolean;
  accepted: number[];
  missing: string[]; // acceptance items nobody confirmed
  outOfScope: Array<{ seq: number; id: string; who: string; action: string; target: string; why: string }>;
  unattributed: number; // file changes by `unknown` actors inside the window (cannot be judged)
  workEvents: number;
  verdict: "on-track" | "complete" | "drifting" | "no-work-yet";
  text: string;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function openContract(l: Ledger, by: { kind: "human"; name: string }, c: { id: string; goal: string; acceptance?: string[]; inScope?: string[]; outOfScope?: string[] }) {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(c.id)) throw new Error("contract id: lowercase letters, digits, dashes");
  if (!c.goal.trim()) throw new Error("goal required");
  if (liveContracts(l).some((x) => x.id === c.id)) throw new Error(`contract ${c.id} is already open`);
  return l.append({ actor: by, action: "contract.open", target: c.id, summary: c.goal, payload: { acceptance: c.acceptance ?? [], inScope: c.inScope ?? [], outOfScope: c.outOfScope ?? [] }, source: "manual" });
}

export function liveContracts(l: Ledger): Contract[] {
  const out = new Map<string, Contract>();
  for (const e of l.all()) {
    if (e.delta !== 1 || l.isReversed(e.id)) continue;
    if (e.action === "contract.open" && e.target) {
      const p = (e.payload ?? {}) as { acceptance?: string[]; inScope?: string[]; outOfScope?: string[] };
      out.set(e.target, { id: e.target, goal: e.summary ?? "", acceptance: p.acceptance ?? [], inScope: p.inScope ?? [], outOfScope: p.outOfScope ?? [], openedSeq: e.seq, openEventId: e.id });
    } else if (e.action === "contract.close" && e.target) out.delete(e.target);
  }
  return [...out.values()];
}

export function acceptItem(l: Ledger, by: { kind: "human" | "ai"; name: string }, contractId: string, item: number, evidence?: string) {
  const c = findContract(l, contractId);
  if (!c) throw new Error(`no open contract ${contractId}`);
  if (!Number.isInteger(item) || item < 0 || item >= c.acceptance.length) throw new Error("no such acceptance item");
  return l.append({ actor: by, action: "contract.accept", target: contractId, summary: evidence ?? c.acceptance[item], payload: { item }, source: "manual" });
}

export function closeContract(l: Ledger, by: { kind: "human"; name: string }, contractId: string) {
  if (!findContract(l, contractId)) throw new Error(`no open contract ${contractId}`);
  return l.append({ actor: by, action: "contract.close", target: contractId, source: "manual" });
}

const findContract = (l: Ledger, id: string) => liveContracts(l).find((c) => c.id === id);

/** Is a file path inside what the contract allows? */
export function pathInScope(c: Pick<Contract, "inScope" | "outOfScope">, path: string): { ok: boolean; why?: string } {
  const p = norm(path);
  for (const g of c.outOfScope) if (globToRegExp(norm(g)).test(p)) return { ok: false, why: `matches out-of-scope "${g}"` };
  if (c.inScope.length && !c.inScope.some((g) => globToRegExp(norm(g)).test(p))) return { ok: false, why: `not in any in-scope pattern (${c.inScope.join(", ")})` };
  return { ok: true };
}

/** What was to be done vs what was done. Reads the raw ledger every time. */
export function audit(l: Ledger, contractId: string): Audit {
  const closedToo = l.all().find((e) => e.action === "contract.open" && e.target === contractId && e.delta === 1 && !l.isReversed(e.id));
  const c = findContract(l, contractId) ?? (closedToo ? contractFromEvent(closedToo) : undefined);
  if (!c) throw new Error(`no contract ${contractId}`);
  const closed = !findContract(l, contractId);
  const after = l.all().filter((e) => e.seq > c.openedSeq && e.delta === 1 && !l.isReversed(e.id));
  const accepted = [...new Set(after.filter((e) => e.action === "contract.accept" && e.target === c.id).map((e) => (e.payload as { item: number }).item))].sort((a, b) => a - b);
  const missing = c.acceptance.filter((_, i) => !accepted.includes(i));
  const out: Audit["outOfScope"] = [];
  let work = 0, unattributed = 0;
  for (const e of after) {
    if (!e.action.startsWith("file.") || !e.target) continue;
    if (e.actor.kind === "unknown") { unattributed++; continue; }
    if (e.actor.kind === "system") continue;
    work++;
    const r = pathInScope(c, e.target);
    if (!r.ok) out.push({ seq: e.seq, id: e.id, who: `${e.actor.kind}:${e.actor.name}`, action: e.action, target: e.target, why: r.why! });
  }
  const verdict: Audit["verdict"] = out.length ? "drifting" : closed || (c.acceptance.length && !missing.length) ? "complete" : work === 0 ? "no-work-yet" : "on-track";
  const text = [
    `Contract ${c.id}: ${c.goal}`,
    `Status: ${verdict}${closed ? " (closed)" : ""}. ${work} file change(s) by AI/human in scope window.`,
    missing.length ? `Not yet confirmed (${missing.length}/${c.acceptance.length}): ${missing.join(" | ")}` : c.acceptance.length ? "All acceptance items confirmed." : "No acceptance items were defined.",
    out.length ? `OUT OF SCOPE (${out.length}): ${out.map((o) => `${o.target} by ${o.who} — ${o.why}`).join("; ")}` : "Nothing outside scope.",
    unattributed ? `${unattributed} change(s) had no known author and could not be judged.` : "",
  ].filter(Boolean).join("\n");
  return { contract: c, closed, accepted, missing, outOfScope: out, unattributed, workEvents: work, verdict, text };
}

function contractFromEvent(e: LedgerEvent): Contract {
  const p = (e.payload ?? {}) as { acceptance?: string[]; inScope?: string[]; outOfScope?: string[] };
  return { id: e.target!, goal: e.summary ?? "", acceptance: p.acceptance ?? [], inScope: p.inScope ?? [], outOfScope: p.outOfScope ?? [], openedSeq: e.seq, openEventId: e.id };
}
