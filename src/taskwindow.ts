// Task-window inheritance: a "why" for AIs that cannot tell us one.
//
// Cursor, Copilot agent mode and most editor assistants expose no hook, so we can never watch them
// reason. But the ledger already knows something nearly as good: you opened a task, you approved it,
// and a named AI pulled it off the queue. Everything that AI does between taking a task and finishing
// it was done *for that task*, with your approval already on record.
//
// So the handshake closes with nothing asked of the vendor:
//   ask        <- the task text you dispatched
//   approvedBy <- whoever appended the dispatch.approve
//   provenance <- "declared" (the AI accepted the task; it did not justify this particular action)
//
// An AI that says more than that, via log_reason or a `why` argument, overrides this with its own words.

import type { Ledger } from "./ledger.ts";
import type { Rationale } from "./types.ts";

export interface OpenTask {
  dispatchId: string;
  task: string;
  approvedBy?: string;
  takenAt: string;
}

/**
 * The task this AI currently holds: the most recent one it took and has not finished.
 *
 * Only an approved dispatch counts. A task queued but never approved must not lend its authority to
 * anything -- that would turn "who gave the go ahead" into a guess, which is the one thing this
 * system must not do.
 */
export function openTaskFor(l: Ledger, aiName: string): OpenTask | undefined {
  const all = l.all();
  const finished = new Set<string>();
  for (const e of all) if (e.action === "dispatch.done" && e.target && !l.isReversed(e.id)) finished.add(e.target);

  for (let i = all.length - 1; i >= 0; i--) {
    const taken = all[i]!;
    if (taken.action !== "dispatch.taken" || taken.actor.name !== aiName) continue;
    if (l.isReversed(taken.id)) continue;
    const dispatchId = taken.target;
    if (!dispatchId || finished.has(dispatchId)) continue;

    const dispatch = all.find((e) => e.id === dispatchId && e.action === "dispatch");
    if (!dispatch || l.isReversed(dispatch.id)) continue;

    const approval = all.find((e) => e.action === "dispatch.approve" && e.target === dispatchId && !l.isReversed(e.id));
    if (!approval) continue; // queued but not approved: it carries no authority

    return {
      dispatchId,
      task: dispatch.summary ?? "",
      approvedBy: approval.approval?.by ?? approval.actor.name,
      takenAt: taken.ts,
    };
  }
  return undefined;
}

/**
 * Build the rationale for something an MCP AI is doing now.
 * `said` is the AI's own account when it offered one, and always wins over the inherited task.
 */
export function rationaleFor(l: Ledger, aiName: string, said?: string): Rationale {
  const t = openTaskFor(l, aiName);
  if (!t && !said) return { provenance: "absent" };
  return {
    provenance: "declared",
    ...(t?.task ? { ask: t.task } : {}),
    ...(said ? { reason: said } : {}),
    ...(t?.approvedBy ? { approvedBy: t.approvedBy } : {}),
    ...(t ? { ref: { dispatchId: t.dispatchId } } : {}),
  };
}
