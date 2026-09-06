# Provenance — units absorbed from WebMux

Centralised record, with **no per-file licence header**, as required by
[`§41`](research/2026-09-06-webmux-absorption.md) of the absorption plan and by
`§7` of its executable companion.

## Frozen upstream baseline

| Item | Value |
|---|---|
| Upstream | `windmill-labs/webmux` |
| Frozen commit | `d8c9d5fa2fc061bff1425de2910d784a48961f1e` (`main`, 2026-08-14) |
| Version | `0.43.1` |
| Local copy | `.references/webmux-main` (gitignored, `/.references` in `.gitignore:3`) |
| Integrity check | `diff -rq` against a clone of `d8c9d5f`: identical, zero differences |
| Declared licence | `package.json:74` says `"license": "MIT"`; the repository publishes **no `LICENSE` file** and the GitHub API answers `"license": null` |

`.references/webmux-main/` is **read-only**. It is the comparison baseline for
parity verification, and editing it destroys the ability to verify that a port
preserved behaviour.

## Rules

1. One row per origin→destination pair, added in the same PR that performs the
   port.
2. `NOTICE` at the repository root acknowledges WebMux as an architectural
   origin.
3. While the upstream publishes no licence text, no file is copied verbatim —
   which ADR-01 already guarantees, since the WebMux backend is Bun-only and no
   file of it compiles under Node without translation.

Strategies: `PORT` (translated, structure preserved) · `ADAPT` (translated with
a deliberate structural change) · `MERGE` (the Issue Flow implementation is
canonical and absorbs behaviour from the upstream one) · `REIMPLEMENT` (written
from the documented behaviour, not from the upstream source).

## Ported units

| Destination | Upstream origin | Repo | Commit | Strategy | Declared licence |
|---|---|---|---|---|---|
| `packages/issue-flow/src/web/server.ts` (`/api/stream`) | `backend/src/server.ts` (WebSocket push, `sendWs()`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/web/session-directory.ts` (storage watch, `subscribe()`) | `backend/src/server.ts` + `backend/src/services/reconciliation.ts` (push-on-change) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/public/app.js` (EventSource client) | `frontend/src/lib/Terminal.svelte` (client-driven reconnect) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/hooks/contract.ts` | `backend/src/domain/events.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/hooks/agentctl.ts` | `backend/src/adapters/agent-runtime.ts` (`buildAgentCtlScript`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/hooks/install.ts` | `backend/src/adapters/agent-runtime.ts` (hook settings, merges, `resolveGitCommonDir`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/hooks/control-server.ts` | `backend/src/adapters/control-token.ts` + `backend/src/server.ts` (runtime-events route) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/hooks/apply.ts` | `backend/src/services/project-runtime.ts` (runtime event projection) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/worktree/git.ts` | `backend/src/adapters/git.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/worktree/lifecycle.ts` | `backend/src/services/lifecycle-service.ts` + `services/worktree-service.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/worktree/meta.ts` | `backend/src/adapters/fs.ts` + `domain/model.ts` (`WorktreeMeta`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/worktree/paths.ts` | `backend/src/adapters/fs.ts` (path helpers) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/worktree/progress.ts` | `backend/src/services/worktree-creation-service.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/worktree/gc.ts` | `backend/src/services/auto-remove-service.ts` + `auto-pull-service.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/conventions/git/auto-name.ts` | `backend/src/services/auto-name-service.ts` (prompt, `normalizeGeneratedBranchName`, timeout fallback) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/conventions/git/auto-name.ts` (`generateFallbackBranchName`) | `backend/src/lib/branch-name.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/conventions/git/slug.ts` (`sanitizeBranchName`, `isValidBranchName`) | `backend/src/domain/policies.ts:8–24` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
