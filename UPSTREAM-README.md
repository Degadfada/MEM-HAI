# AI Handoff Ledger

A local tool that records who did what in a project (you vs. which AI), whether you approved it, and hands the
project's memory to the next AI when you switch. No cloud, no dependencies at runtime.

## Pieces
| Phase | File | What it does |
|---|---|---|
| 1 | `src/ledger.ts`, `redact.ts` | append-only, hash-chained log; secrets redacted before write; reversals as negative updates |
| 0/2 | `src/sketch.ts`, `facts.ts`, `score.ts`, `metrics.ts` | Count-Min surprisal, Misra-Gries, MinHash; typed facts that cite their source events |
| 3 | `src/distill.ts` | budgeted selection (cost-benefit greedy on a submodular objective); hard rules always kept |
| 4 | `src/handoff.ts` | renders CLAUDE.md / AGENTS.md / system prompt / MCP JSON |
| 5 | `src/verify.ts` | property tester + budget-growing loop; hard rules and undone items checked exhaustively |
| 6 | `src/server.ts`, `hooks/`, `extension/` | 127.0.0.1 dashboard (token + Host check), Claude Code hook, VS Code extension |

## v0.2: guardrails, contracts, MCP
- **Guardrails** (`src/guardrails.ts`): rules every AI must follow. `block` rules are enforced; `advise` rules are told to every AI.
  Enforced for Claude Code through the PreToolUse hook (deny + reason) and for any MCP client through `check_action`.
  Tools that are not in our path (Copilot chat, closed editors) can only be told the rules and audited afterwards.
- **Task contracts** (`src/scope.ts`): goal, "done when" items, allowed paths. `audit` compares what was asked with what the ledger
  shows was done and flags out-of-scope edits. Scope is audited, not blocked. Edits by unknown authors are reported, not blamed.
- **MCP server** (`src/mcp.ts`): `node dist/cli.js mcp --agent cursor --file .handoff/ledger.jsonl`. Tools: get_brief, get_guardrails,
  check_action, get_contracts, check_scope, confirm_acceptance, audit_contract, log_decision. Add it to any MCP client, e.g. `.mcp.json`:

      { "mcpServers": { "handoff": { "command": "node", "args": ["/path/to/dist/cli.js", "mcp", "--agent", "cursor", "--file", ".handoff/ledger.jsonl"] } } }

## v0.3: many AIs, a steward, projects, remote
- **Providers** (`src/providers.ts`): Anthropic, Gemini and Ollama adapters. Keys are read from environment variables you name; they are never stored.
  One *editor* and one *steward* can be awake; waking one puts the previous holder to sleep. A daily token budget is checked before every call.
- **Steward** (`src/steward.ts`): compiles a short prompt from rules + scope + done-when + relevant history + technique cards, queues it for the
  editor AI (`next_task` over MCP), reviews asked-vs-done, writes per-project summaries. An LLM draft is accepted only if it keeps every rule and the goal; otherwise the rule-based prompt is used.
- **Knowledge** (`src/knowledge.ts`): `knowledge ingest --path book.txt` turns text into cited technique cards (LLM-paraphrased if a steward is awake, rule-based otherwise); BM25 search.
- **Learning** (`src/learn.ts`): each finished dispatch yields a reward from the ledger (scope kept, no blocks, no reversals, acceptance met). A Thompson-sampling bandit and a small neural net
  choose the prompt technique per task type. Replayed from ledger events, so it is auditable. It needs data: ~chance at 100 outcomes, ~70% at 400, ~100% at 1500 in our simulation.
- **Projects** (`src/projects.ts`): register projects; per-project summaries; `consolidate` finds facts that recur across projects. Machine-wide guardrails (`guardrail add --global`) apply to all.
- **Remote** (`src/auth.ts`, `src/server.ts`): `auth set-password`, then `serve --allow-host your-tunnel-host`, and point a Cloudflare tunnel (with Cloudflare Access in front) at the printed local port.
  Remote users can read, queue tasks (they wait for approval on this computer), add guardrails, open contracts. Undo, approve, wake/sleep, switch and event writes are local-only.

## Use
Requires Node >= 22.18 for the TypeScript sources; the compiled `dist/` runs on any recent Node.

    npm test                         # 132 tests
    ./build-ext.sh                   # compile core into dist/ and stage extension/
    node dist/cli.js serve           # dashboard; prints a URL containing a one-time token
    node dist/cli.js brief --to copilot --target claude-md

VS Code: `code --install-extension ai-handoff-ledger-0.1.0.vsix`, then from the command palette:
1. **Handoff: Install Claude Code hook**: records Claude Code's edits and commands as AI actions.
2. **Handoff: Switch AI and push memory**: logs the switch, builds a verified brief, writes CLAUDE.md / AGENTS.md.
3. **Handoff: Open dashboard**, plus commands to record rules, decisions, tasks and refused AI actions.

## Honest limits
- Attribution: only AIs with a hook (Claude Code today) are attributed exactly. Editor saves are attributed to you.
  Any other file change is recorded as `unknown`, not guessed. Add adapters for other AIs as they expose hooks.
- Approval is inferred for Claude Code: a permission notification before a tool runs is logged as your approval; a tool
  that ran with no prompt is `not_required`. Refusals are not detectable by the hook; use "Record an AI action I refused".
- The default verification reader is lexical (does the brief contain the fact). Plug an LLM-backed `Reader` into
  `verifyBrief` for semantic checks.
- Secret redaction is pattern-based; unusual secret formats can slip through.
- The AI adapters were tested against fake servers that speak each vendor's wire format, not the live APIs (no keys or network in the build sandbox). Check model names and the first real call yourself.
- The Cloudflare tunnel itself was not run; the login, host allow-list, throttling and local-only rules were tested with real HTTP and tunnel-style Host/forwarding headers.
- The "ANN" is a small network trained on your own outcomes. It will not out-think the steward LLM; it learns which prompt technique works for which task type, and only once it has data.
- A broken or unreadable ledger makes the hook fail open (the agent keeps working); a bad guardrail rule is skipped, never fatal.
- Tested against a mocked VS Code API, not inside a real VS Code window (that download is blocked in the build sandbox).
