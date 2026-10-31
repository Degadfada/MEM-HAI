import type { LedgerEvent } from "./types.ts";
import type { Scored } from "./score.ts";
import { estimateTokens } from "./score.ts";

export interface BriefMetrics {
  rawTokens: number; // lossless cost of the whole log
  briefTokens: number;
  compressionRatio: number;
  hardTotal: number;
  hardKept: number; // must equal hardTotal
  utilityKept: number; // fraction of total utility retained
  factsTotal: number;
  factsKept: number;
}

export function rawTokens(events: readonly LedgerEvent[]): number {
  return events.reduce((n, e) => n + estimateTokens(JSON.stringify(e)), 0);
}

export function briefMetrics(events: readonly LedgerEvent[], all: Scored[], kept: Scored[], briefText: string): BriefMetrics {
  const raw = rawTokens(events);
  const brief = estimateTokens(briefText);
  const tot = all.filter((f) => !f.hard).reduce((n, f) => n + f.utility, 0) || 1;
  const keptU = kept.filter((f) => !f.hard).reduce((n, f) => n + f.utility, 0);
  return {
    rawTokens: raw,
    briefTokens: brief,
    compressionRatio: raw / Math.max(1, brief),
    hardTotal: all.filter((f) => f.hard).length,
    hardKept: kept.filter((f) => f.hard).length,
    utilityKept: keptU / tot,
    factsTotal: all.length,
    factsKept: kept.length,
  };
}
