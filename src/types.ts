export type ActorKind = "human" | "ai" | "system" | "unknown"; // unknown = file changed, nobody claimed it

// How the author was established. "exact" came from a hook, an MCP client or a deliberate entry:
// the actor named itself. "inferred" means we saw the change and attributed it to whichever AI was
// declared in use at the time -- useful and usually right, but a deduction, never passed off as proof.
// "unattributed" means nobody claimed it and we refuse to guess.
export type Confidence = "exact" | "inferred" | "unattributed";
export type ApprovalStatus = "approved" | "denied" | "pending" | "not_required" | "unknown";

// How well we know WHY an action happened. The ladder is ordered by the strength of the evidence,
// and like Confidence it is never bluffed: no recoverable reason reads "absent", it is not invented.
//   recorded - we made the API call ourselves, so we hold both sides of the exchange. Primary evidence.
//   cited    - quoted out of a vendor transcript (a hook told us where to look).
//   declared - the actor said it over MCP, or inherited an approved task it had taken.
//   absent   - nothing on record.
export type Provenance = "recorded" | "cited" | "declared" | "absent";

/** Why an action happened: the instruction behind it and the actor's own account of it. */
export interface Rationale {
  /** The human instruction that led here. Redacted, and capped at EXCERPT_CHARS. */
  ask?: string;
  /** What the actor said it was doing. Redacted, and capped at EXCERPT_CHARS. */
  reason?: string;
  provenance: Provenance;
  /** Who approved it, when that is known from an approved dispatch rather than inferred. */
  approvedBy?: string;
  /** Citation, so the untruncated original stays findable even though we only store an excerpt. */
  ref?: {
    sessionId?: string;
    promptId?: string;
    toolUseId?: string;
    transcript?: string;
    exchangeSha256?: string;
    dispatchId?: string;
  };
}

/** Excerpts are capped so that a 13k-event ledger stays a ledger and not a copy of every conversation. */
export const EXCERPT_CHARS = 280;

export interface Actor {
  kind: ActorKind;
  name: string; // e.g. "idahosa", "claude-code", "copilot"
}

export interface Approval {
  status: ApprovalStatus;
  by?: string;
  at?: string; // ISO time the approval happened (may differ from event time)
}

export interface EventInput {
  actor: Actor;
  confidence?: Confidence; // defaults to "exact" for named actors, "unattributed" for unknown
  rationale?: Rationale; // why this happened; defaults to { provenance: "absent" }
  aiInUse?: string; // which AI the human was using when this happened
  action: string; // e.g. "file.edit", "command.run", "decision", "ai.switch"
  target?: string; // path, command, topic
  summary?: string; // short human-readable line
  payload?: Record<string, unknown>;
  approval?: Approval;
  source?: string; // capture source: "hook", "git", "vscode", "manual"
  reverses?: string; // id of an earlier event this one undoes
  ts?: string; // override for imports/tests; defaults to now
}

export interface LedgerEvent extends Required<Pick<EventInput, "actor" | "action">> {
  type: "event";
  id: string; // random 64-bit, 16 hex chars
  seq: number;
  ts: string;
  delta: 1 | -1; // +1 normal, -1 reversal (strict turnstile: never below zero)
  confidence?: Confidence; // absent on events written before this was recorded; see confidenceOf()
  rationale?: Rationale; // absent on events written before this was recorded
  aiInUse?: string;
  target?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  approval: Approval;
  source?: string;
  reverses?: string;
  redactions?: { count: number; kinds: string[] };
  prev: string;
  hash: string;
}

export interface LedgerHeader {
  type: "header";
  version: 1;
  created: string;
  // Seeds fixed at creation so sketches built later are mergeable and reproducible.
  seeds: { countMin: number[]; minHash: number[] };
  genesis: string; // hash of the header body; first event's prev
  hash: string;
}
