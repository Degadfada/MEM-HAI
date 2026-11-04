# MEM-HAI

> A memory system that sits in between a human and an AI system, or a group of AI systems, to ensure
> that a project is owned by the human via the machine — and not by the AIs, their vendor, or their
> tools.

That is the whole idea. Everything below is how it is kept true.

**The AI–human handshake for your projects.** A local, tamper-evident record of what was done, **why**
it was done, **who** gave the go-ahead, and **when** — held outside any AI, so changing AI does not
change your project's memory.

No cloud. No account. No runtime dependencies. The whole thing is a file in your repo and a dashboard
on `127.0.0.1`.

---

## The problem

You use several AIs on one codebase. Each starts amnesiac, each knows only its own conversation, and
none can tell you what the last one did or why. When something breaks three weeks later the reasoning
is gone — it lived in a chat window that has since been cleared.

So the record of your own project exists only inside the tools that changed it. That is the gap this
closes.

## What it records

Every action gets four things, and refuses to invent any of them:

| | |
|---|---|
| **what** | the file, the command, the decision, the rule |
| **who** | you, or which AI — with how well we know it |
| **why** | the instruction behind it, and the actor's own account of it |
| **when** | plus how long each AI worked, reconstructable for any past day |

### Attribution is graded, never guessed

| | |
|---|---|
| `exact` | a hook or MCP client named itself |
| `inferred` | the file changed while you had that AI declared in use — a deduction, labelled as one |
| `unattributed` | nobody claimed it, and we will not guess |

### Provenance is graded too, strongest evidence first

| | |
|---|---|
| `recorded` | **we made the API call**, so we hold both sides of the exchange |
| `cited` | quoted from a vendor transcript, with the prompt and tool-call ids to find it again |
| `declared` | the AI said so over MCP, or inherited a task you approved |
| `absent` | nothing on record — surfaced for annotation, never fabricated |

**Every AI is covered, not just one.** Models reached over an API get the strongest tier, because we
are the client. Editor assistants that expose no hook at all — Copilot, Cursor — still answer "why"
and "who approved it" by inheriting the approved task they are working under, needing no cooperation
from the vendor.

## Install

```bash
git clone <this repo> && cd ai-handoff-ledger
npm ci && npm test            # 188 tests
./build-ext.sh                # compile core, stage the extension
cd extension && npx @vscode/vsce package
code --install-extension ai-handoff-ledger-*.vsix
```

Then, in any project:

```bash
node .handoff/core/cli.js init
```

One command: stages the hook, wires MCP for Claude Code and VS Code agent mode, gitignores the ledger,
and registers the project. Idempotent, and it merges into existing settings rather than overwriting
them. Restart Claude Code for the hook; reload the window for MCP.

## Use it

```bash
cli.js serve                       # dashboard on 127.0.0.1, URL carries a one-time token
cli.js days                        # every day that has history
cli.js day --date 2026-11-04       # who worked, how long, on what
cli.js guardrail add --level block --kind command --pattern "git push.*production" \
                     --text "Never push straight to production."
cli.js contract open --id fix-upload --goal "..." --accept "a;b" --in "src/**"
cli.js contract audit --id fix-upload     # done vs asked vs out of scope
cli.js brief --to copilot --target claude-md   # hand the memory to the next AI
cli.js verify                      # is the chain intact
```

The dashboard has six tabs — Projects, History, **Why**, Rules, Contracts, AIs — bottom-anchored so it
works one-handed on a phone through a tunnel. **Why** is the backlog of actions with no reason on
record; annotating one appends a new event citing the original, because the log is append-only and a
reason added later is itself part of the record.

## Plug in any API model

```bash
cli.js providers add --name kimi --kind openai-compatible \
        --model moonshot-v1-128k --key-env MOONSHOT_API_KEY \
        --base-url https://api.moonshot.cn
cli.js providers wake --name kimi --role steward
```

Kinds: `anthropic`, `gemini`, `ollama`, `openai-compatible`. The last reaches OpenAI, Kimi/Moonshot,
DeepSeek, Groq, OpenRouter, vLLM and most local servers. **Keys are never stored** — a provider names
an environment variable, read at call time. One editor and one steward may be awake, and a daily token
budget is checked before every call.

## Guardrails are enforced where we sit in the path

`block` rules genuinely deny a Claude Code tool call through the PreToolUse hook, and any MCP client
through `check_action`. Tools outside our path can only be *told* the rules and audited afterwards —
and the record says which happened. A refused attempt is logged together with what the AI was trying
to achieve.

## Integrity

The log is append-only and hash-chained: each event carries the previous event's hash, so an
alteration anywhere breaks the chain and `verify` says so. Mistakes are corrected by appending a
reversal, never by editing.

Appends take an **exclusive cross-process lock**. Not theoretical: the hook, the extension host, the
CLI and the dashboard all write one file, and without the lock two appends in the same millisecond
claim the same position and fork the chain — observed in a real project ledger. Proven with concurrent
writer processes in CI, on Linux and Windows.

Two recovery tools, both of which keep the original and record themselves as events:

- **`repair --yes`** re-links a chain already forked. Re-linking necessarily changes every later hash,
  so the pre-repair file is kept beside it and its SHA-256 recorded. An exact replayed line is
  dropped; two events sharing an id with *different* contents is refused rather than resolved by
  picking one.
- **`compact --yes`** — a running app rewrites its own database thousands of times an hour, and on one
  real project that was 93% of all events, burying the record. Compaction moves that churn to an
  archive file, never deletes it, and keeps anything owned, explained, approved or reversed. The
  archive keeps each event's **original** seq and hash, so it can be matched line for line against
  the preserved pre-compaction ledger. That makes it evidence rather than a second working log --
  and it is deliberately not a valid chain on its own, because re-chaining it would destroy the very
  hashes that tie it back to the original.

## Secrets

Everything is redacted before it is hashed or written, including conversation excerpts — the most
likely place for a pasted key to turn up. Excerpts are capped at 280 characters with the truncation
visible, and a citation points at the untruncated original. Redaction is pattern-based, so an unusual
secret format can still slip through.

## Remote access

`auth set-password`, then `serve --allow-host your-tunnel-host` behind a tunnel you control. Remote
users can read, queue tasks for your approval, add guardrails and open contracts. Undo, approve,
wake/sleep, switching AI and direct event writes stay **local-only**. The password file is owner-only
on every platform: `chmod` where that means something, and an ACL rewrite on Windows, where NTFS
ignores POSIX mode bits and `chmod 0600` is a no-op that merely looks like security.

## Honest limits

- **Attribution** is exact only for AIs with a hook (Claude Code today) or an MCP client that names
  itself. Copilot and Cursor file edits are `inferred` — their *why* is covered, their *authorship* is
  a deduction. Editor saves are attributed to you. Anything else is `unattributed`, not guessed.
- **Approval** is inferred for Claude Code: a permission prompt before a tool runs is logged as your
  approval, a tool that ran unprompted is `not_required`. **Refusals are invisible to the hook** —
  when you turn something down, that only enters the record if you record it. Those are among the most
  valuable facts here, and the one thing that cannot be captured automatically.
- **One stated reason often covers a burst of actions.** A faithful picture of how work happens, not
  one bespoke justification per action.
- The AI's **private reasoning is deliberately not captured** — only what it said out loud, which is
  the claim it actually made to you.
- The provider adapters were tested against fake servers speaking each vendor's wire format, not the
  live APIs. Check model names on your first real call.
- The learning layer needs data before it helps: roughly chance at 100 outcomes, ~70% at 400.
- A broken or unreadable ledger makes the hook **fail open** — the AI keeps working, the record is
  poorer. A bad guardrail rule is skipped, never fatal.

## Requirements

Node >= 22.18 to run the TypeScript sources directly; the compiled `dist/` runs on any recent Node.
VS Code >= 1.85 for the extension.

## Credits

Developed by **Edimekabasi E. AKpaneka**. See [AUTHORS.md](AUTHORS.md). MIT licensed.

The prototype this grew from is preserved as the first commit, and its original notes are kept as
[UPSTREAM-README.md](UPSTREAM-README.md).
