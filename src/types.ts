export type ActorKind = "human" | "ai" | "system" | "unknown"; // unknown = file changed, nobody claimed it
export type ApprovalStatus = "approved" | "denied" | "pending" | "not_required" | "unknown";

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
