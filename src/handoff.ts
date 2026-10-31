import type { LedgerEvent } from "./types.ts";
import type { Scored } from "./score.ts";
import { buildModel, scoreFacts, estimateTokens } from "./score.ts";
import { extractFacts } from "./facts.ts";
import { dedupe, distill } from "./distill.ts";
import { briefMetrics, type BriefMetrics } from "./metrics.ts";
import type { Ledger } from "./ledger.ts";

export type Target = "claude-md" | "agents-md" | "system-prompt" | "mcp-json";

export const TARGET_BUDGETS: Record<Target, number> = {
  "claude-md": 1500,
  "agents-md": 1500,
  "system-prompt": 1000,
  "mcp-json": 2500,
};

export interface Brief {
  target: Target;
  from?: string;
  to: string;
  text: string;
  kept: Scored[];
  all: Scored[];
  metrics: BriefMetrics;
  ledgerHead: { events: number; hash: string };
}

const short = (id: string) => id.slice(0, 8);
const SECTION: Array<[string, (f: Scored) => boolean]> = [
  ["Hard rules (never violate)", (f) => f.kind === "constraint"],
  ["Things the human refused", (f) => f.kind === "denial"],
  ["Decisions", (f) => f.kind === "decision"],
  ["Open tasks", (f) => f.kind === "task"],
  ["Where the code stands", (f) => f.kind === "file"],
  ["Commands run", (f) => f.kind === "command"],
  ["How the human works with AI", (f) => f.kind === "approval_pattern" || f.kind === "ai_switch"],
];

function body(kept: Scored[]): string {
  const out: string[] = [];
  for (const [title, pick] of SECTION) {
    const items = kept.filter(pick).sort((a, b) => a.firstSeq - b.firstSeq);
    if (!items.length) continue;
    out.push(`## ${title}`, ...items.map((f) => `- ${f.text} [${short(f.sources[f.sources.length - 1]!)}]`), "");
  }
  return out.join("\n");
}

/** Which AIs have been in use, in order, collapsed. */
export function aiTrail(events: readonly LedgerEvent[]): string[] {
  const undone = new Set(events.filter((e) => e.reverses).map((e) => e.reverses!));
  const trail: string[] = [];
  for (const e of events) if (e.delta === 1 && !undone.has(e.id) && e.aiInUse && trail[trail.length - 1] !== e.aiInUse) trail.push(e.aiInUse);
  return trail;
}

export function makeBrief(ledger: Ledger, to: string, target: Target, budget = TARGET_BUDGETS[target]): Brief {
  const events = ledger.all();
  const model = buildModel(events, ledger.header.seeds.countMin);
  const scored = dedupe(scoreFacts(extractFacts(events), events, model), ledger.header.seeds.minHash);
  const trail = aiTrail(events);
  const from = trail.filter((a) => a !== to).pop();
  const head = { events: events.length, hash: events.length ? events[events.length - 1]!.hash.slice(0, 12) : ledger.header.genesis.slice(0, 12) };

  const preamble =
    `You are ${to}, taking over an in-progress project${from ? ` from ${from}` : ""}. ` +
    `Everything below was recorded by the human's handoff ledger (AI history: ${trail.join(" → ") || "none"}). ` +
    `Treat hard rules as binding. Bracketed codes like [a1b2c3d4] are ledger event IDs; ask for them if you need the full record.`;
  const footerFor = (k: number, over: boolean) => `_Ledger head: ${head.events} events, hash ${head.hash}. This brief is lossy by design (${k} of ${scored.length} facts)._${over ? "\n_WARNING: hard rules alone exceed the budget._" : ""}`;

  // Reserve room for preamble, footer, section headings; charge each fact its citation overhead.
  const reserve = estimateTokens(preamble) + estimateTokens(footerFor(scored.length, false)) + 50;
  const withCite = scored.map((f) => ({ ...f, tokens: f.tokens + 4 }));
  const { kept, overBudgetByHard } = distill(withCite, Math.max(0, budget - reserve));

  const footer = footerFor(kept.length, overBudgetByHard);
  let text: string;
  switch (target) {
    case "claude-md":
      text = `# Project memory (handoff)\n\n${preamble}\n\n${body(kept)}\n${footer}\n`;
      break;
    case "agents-md":
      text = `# AGENTS.md — project handoff\n\n${preamble}\n\n${body(kept)}\n${footer}\n`;
      break;
    case "system-prompt":
      text = `${preamble}\n\n${body(kept).replace(/^## /gm, "").replace(/^- /gm, "• ")}\n${footer.replace(/_/g, "")}\n`;
      break;
    case "mcp-json":
      text = JSON.stringify(
        { to, from: from ?? null, aiTrail: trail, ledgerHead: head, rules: kept.filter((f) => f.hard).map((f) => ({ text: f.text, sources: f.sources })), facts: kept.filter((f) => !f.hard).map((f) => ({ kind: f.kind, text: f.text, sources: f.sources.slice(-3) })) },
        null, 2);
      break;
  }
  const metrics = briefMetrics(events, scored, kept, text);
  return { target, from, to, text, kept, all: scored, metrics, ledgerHead: head };
}

export const FILENAME: Record<Target, string> = {
  "claude-md": "CLAUDE.md",
  "agents-md": "AGENTS.md",
  "system-prompt": "handoff-system-prompt.txt",
  "mcp-json": "handoff-brief.json",
};
export { estimateTokens };
