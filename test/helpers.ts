import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";

export const tmpPath = () => join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
export const human = { kind: "human" as const, name: "me" };
export const claude = { kind: "ai" as const, name: "claude-code" };
export const copilot = { kind: "ai" as const, name: "copilot" };

/** A small but realistic project history used across tests. */
export function sampleLedger(): Ledger {
  const l = new Ledger(tmpPath());
  l.append({ actor: human, action: "constraint", summary: "Never modify the production database or run migrations without asking", target: "db" });
  l.append({ actor: human, action: "constraint", summary: "Use pnpm, not npm", target: "tooling" });
  l.append({ actor: human, action: "ai.switch", aiInUse: "claude-code", summary: "start with claude-code" });
  l.append({ actor: human, action: "decision", target: "auth", summary: "Use session cookies, not JWT, for the web app" });
  for (let i = 0; i < 30; i++)
    l.append({ actor: claude, action: "file.edit", target: `src/ui/c${i % 6}.tsx`, aiInUse: "claude-code", approval: { status: "approved", by: "me" }, summary: `tweak component ${i}` });
  for (let i = 0; i < 12; i++)
    l.append({ actor: claude, action: "command.run", target: "pnpm test", aiInUse: "claude-code", approval: { status: "approved", by: "me" }, summary: `run tests round ${i}` });
  l.append({ actor: claude, action: "file.edit", target: "src/auth/session.ts", aiInUse: "claude-code", approval: { status: "approved", by: "me" }, summary: "implement session store" });
  l.append({ actor: claude, action: "command.run", target: "psql prod -c 'DROP TABLE users'", aiInUse: "claude-code", approval: { status: "denied", by: "me" }, summary: "tried to drop table" });
  const wrong = l.append({ actor: claude, action: "decision", target: "styling", summary: "Switch to Tailwind", aiInUse: "claude-code" });
  l.reverse(wrong.id, human, "not doing tailwind");
  l.append({ actor: human, action: "task.open", target: "rate-limit-login", summary: "add rate limiting to /login" });
  l.append({ actor: human, action: "task.open", target: "fix-footer", summary: "footer overlaps on mobile" });
  l.append({ actor: human, action: "task.done", target: "fix-footer" });
  l.append({ actor: human, action: "ai.switch", aiInUse: "copilot", summary: "moving to copilot" });
  return l;
}
