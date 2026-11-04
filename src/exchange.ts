// Our own record of every API call we make.
//
// For an AI we reach over an API we are the client, so we hold both sides of the exchange in our own
// process. Writing it here makes that primary evidence durable and independent of any vendor: no log
// format to track, no history that can be cleared out from under us, nothing to scrape. This is why
// API-driven AIs reach "recorded" provenance, the strongest tier.
//
// The ledger stores a short redacted excerpt plus the sha256 produced here; the untruncated text
// lives in these files. Append-only, one file per day per provider.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./canonical.ts";
import { redactDeep } from "./redact.ts";
import type { Completion } from "./providers.ts";

export interface Exchange {
  ts: string;
  provider: string;
  model: string;
  /** Identifies this exchange from the ledger. sha256 of the untruncated prompt + reply. */
  sha256: string;
  system?: string;
  prompt: string;
  reply: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  /** The dispatch this call served, when it served one. */
  dispatchId?: string;
}

export const exchangeDir = (home: string): string => join(home, "exchanges");

/** sha256 over the exact bytes of the exchange, so the ledger can cite it and it can be re-verified. */
export function exchangeHash(prompt: string, reply: string, system?: string): string {
  return sha256(JSON.stringify({ system: system ?? null, prompt, reply }));
}

/**
 * Record one call. Everything is redacted first: a prompt is the most likely place for a pasted key
 * or a client's details to turn up, and these files are as readable as the ledger itself.
 */
export function recordExchange(
  home: string,
  c: Completion,
  o: { dispatchId?: string; now?: () => Date } = {},
): Exchange {
  const prompt = c.request?.prompt ?? "";
  const system = c.request?.system;
  const hash = exchangeHash(prompt, c.text, system);
  const ts = (o.now ? o.now() : new Date()).toISOString();

  const { value: clean } = redactDeep({ system, prompt, reply: c.text });
  const row: Exchange = {
    ts,
    provider: c.provider,
    model: c.model,
    sha256: hash,
    ...(clean.system ? { system: clean.system } : {}),
    prompt: clean.prompt,
    reply: clean.reply,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
    ...(o.dispatchId ? { dispatchId: o.dispatchId } : {}),
  };

  const dir = exchangeDir(home);
  mkdirSync(dir, { recursive: true });
  // Provider name is validated to [a-z0-9_-] on registration, so it is safe in a filename.
  appendFileSync(join(dir, `${ts.slice(0, 10)}-${c.provider}.jsonl`), JSON.stringify(row) + "\n");
  return row;
}

/** Resolve a citation back to the full exchange, for the dashboard. */
export function findExchange(home: string, hash: string): Exchange | undefined {
  const dir = exchangeDir(home);
  if (!existsSync(dir)) return undefined;
  // Newest first: a citation being looked at is far likelier to be recent.
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort().reverse()) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line || !line.includes(hash)) continue;
      try {
        const row = JSON.parse(line) as Exchange;
        if (row.sha256 === hash) return row;
      } catch { /* a torn final line: skip it */ }
    }
  }
  return undefined;
}

/**
 * The model's own account of what it was doing: its opening statement, before any detail.
 * Mirrors the hook path, which takes what the AI said out loud rather than its private reasoning.
 */
export function statedReason(reply: string): string | undefined {
  const text = reply.trim();
  if (!text) return undefined;
  // First sentence or first line, whichever comes first.
  const line = text.split(/\n/)[0]!.trim();
  const stop = line.search(/(?<=[.!?])\s/);
  const first = (stop > 0 ? line.slice(0, stop + 1) : line).trim();
  return first || undefined;
}
