# Shared: reading the resolved agent

**One source, many references.** Every skill that needs to know *which* coding
agent will run a phase reads this block instead of restating it. When the
resolution changes, it changes here.

## Why this exists

The CLI and the skills are two paths to the same outcome. The CLI resolves the
agent in `packages/issue-flow/src/agents/`; skills are markdown and cannot
import TypeScript, so `issue-flow agent --json` is the bridge between them.

Without it, each skill would guess the provider from which binary is on the
PATH — the exact auto-detection the CLI refuses to do. The same repository
must resolve the same agent on every machine.

## How to read it

Run this when a decision depends on the configured agent (which model a phase
uses, whether Codex is in the mix, where a preference was written):

```bash
issue-flow agent --json 2>/dev/null
```

If `issue-flow` is not on the PATH, try `npx --yes issue-flow@latest agent --json`
once. Do not retry beyond that.

## Best-effort is the contract

**A skill that needs the network to work is a regression.** Treat this step as
an enrichment that may simply not answer:

| Outcome | What to do |
|---|---|
| Valid JSON | follow the resolution it returns |
| Command not found | assume the default: Claude Code, no `--model` |
| Non-zero exit, empty output, unparseable JSON | assume the default |
| Takes too long | stop waiting; assume the default |

Never fail, never block, and never tell the user to install Codex just to
proceed. Say which path you took only when it changed a decision.

The payload may gain fields in a future release: read the ones you need and
ignore the rest. `schemaVersion` only changes when a reader would have to.

## What the payload carries

```jsonc
{
  "schemaVersion": 1,
  "default": {
    "provider": "claude",          // 'claude' | 'codex' | 'cursor' | 'antigravity'
    "model": null                  // null = provider default, never inferred
  },
  "phases": {
    "analyze":   { "provider": "claude", "model": null, "inherited": true },
    "generate":  { "provider": "claude", "model": null, "inherited": true },
    "prd":       { "provider": "claude", "model": null, "inherited": true },
    "plan":      { "provider": "codex",  "model": null, "inherited": false },
    "execute":   { "provider": "codex",  "model": "gpt-5.6", "inherited": false },
    "review":    { "provider": "claude", "model": null, "inherited": true },
    "pr":        { "provider": "claude", "model": null, "inherited": true },
    "pr-review": { "provider": "claude", "model": null, "inherited": true }
  },
  "availability": [
    { "id": "claude", "installed": true, "version": "2.x.x", "authenticated": true },
    { "id": "codex", "installed": true, "version": "0.149.1", "authenticated": true }
  ]
}
```

The eight keys under `phases` are the eight invocations that actually call an
agent. `init` is not one of them. `inherited: true` means the phase did not
declare its own overlay. Field names may gain extras in a later release —
read `schemaVersion` and the keys you need.

## How to apply it

- **Default is Claude.** An empty or missing payload means Claude Code, no
  `--model`, the same behaviour as every release before the agent layer.
- **Never auto-detect** from which binary is installed. If `phases.execute`
  says `claude` and `codex` is on the PATH, still use Claude.
- **A phase override is partial.** `phases.review.model` without a provider
  keeps the default provider.
- **Do not rewrite the preference** unless the user asked. Writing goes
  through `issue-flow agent use`, never by editing JSON by hand from a skill.
- **Prompts stay vendor-neutral.** `AGENTS.md` is what both agents read; do
  not special-case wording for Claude or Codex.

## When nothing is declared

Every phase on `claude` with `model: null` and `origin: "default"` is the
normal case, and it means the skill behaves exactly as it did before this
layer existed.
