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
| `packages/issue-flow/src/runtime/tmux/gateway.ts` | `backend/src/adapters/tmux.ts` (`BunTmuxGateway`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/tmux/names.ts` | `backend/src/adapters/tmux.ts` (naming helpers) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/tmux/locale.ts` | `backend/src/adapters/tmux.ts` (`pickTmuxLocale`, `chooseUtf8Locale`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/tmux/env.ts` | `backend/src/adapters/project-env.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/tmux/layout.ts` | `backend/src/services/session-service.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/tty.ts` | `backend/src/services/agent-service.ts` (built-in invocations) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/custom.ts` | `backend/src/services/agent-service.ts` (custom agents) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/terminal/input.ts` | `backend/src/adapters/terminal.ts` (`sendPrompt`, `interruptPrompt`, `sendKeys`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/` | `backend/src/domain/model.ts` (`WorktreeConversationMeta`) + `adapters/session-discovery.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/terminal/attach.ts` | `backend/src/adapters/terminal.ts` (`attach`, `buildAttachCmd`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/terminal/pty.ts` | `backend/src/adapters/terminal.ts` (`detectPtyWrapper`, `buildPtyArgs`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/terminal/scrollback.ts` | `backend/src/adapters/terminal.ts` (scrollback ring) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/web/terminal-ws.ts` | `backend/src/server.ts` (WS handlers, `sendWs`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/core/human-hold.ts` | `backend/src/server.ts` (`disarmOneshotIfArmed`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/conventions/git/auto-name.ts` | `backend/src/services/auto-name-service.ts` (prompt, `normalizeGeneratedBranchName`, timeout fallback) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/conventions/git/auto-name.ts` (`generateFallbackBranchName`) | `backend/src/lib/branch-name.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/conventions/git/slug.ts` (`sanitizeBranchName`, `isValidBranchName`) | `backend/src/domain/policies.ts:8–24` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/utils/async.ts` | `backend/src/lib/async.ts` (`mapWithConcurrency`, `startSerializedInterval`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/github/pr.ts` | `backend/src/services/pr-service.ts` (`parsePrResponse`, `parsePrViewStatus`, `fetchAllPrs`, `fetchPrStatus`, `refreshStalePrData`, `fetchBranchPrStates`) | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/github/ci.ts` | `backend/src/services/pr-service.ts` (`dedupeLatestChecks`, `summarizeChecks`, `mapChecks`, `deriveCheckStatus`, `parseRunId`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/github/ci.ts` (`fetchFailedRunLog`) | `backend/src/server.ts:1769` (`apiCiLogs`, `gh run view --log-failed`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/github/comments.ts` | `backend/src/services/pr-service.ts` (`parseReviewComments`, `fetchReviewComments`, ETag cache) | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/github/monitor.ts` | `backend/src/services/pr-service.ts` (`syncPrStatus`, `startPrMonitor`, `startAutoRemoveMonitor`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/github/linked-repos.ts` | `backend/src/domain/config.ts:60` (`LinkedRepoConfig`) + `pr-service.ts` (per-repo fan-out) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/github/types.ts` | `backend/src/domain/model.ts:159–187` (`PrComment`, `CiCheck`, `PrEntry`) + `pr-service.ts` (`Gh*` shapes) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/storage/projects/prefix.ts` | `backend/src/domain/policies.ts` (`sanitizeProjectPrefix`, `deriveProjectPrefix`, `RESERVED_PROJECT_PREFIXES`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/storage/projects/registry.ts` | `backend/src/adapters/projects-registry.ts` + `domain/projects.ts` (`ProjectEntry`, `isProjectEntry`) | windmill-labs/webmux | d8c9d5f | REPLACE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/storage/db/projects.ts` | `backend/src/adapters/projects-registry.ts` (persistence contract) | windmill-labs/webmux | d8c9d5f | REPLACE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/project-manager.ts` | `backend/src/services/project-manager.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/project-runtime.ts` | `backend/src/runtime.ts` (`createWebmuxRuntime`, per-project config) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/project-init.ts` | `backend/src/services/project-init-service.ts` (`ProjectInitTracker`, `runProjectInit`) | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/web/projects-api.ts` | `backend/src/server.ts` (`apiProjects`, `apiAddProject`, `apiRemoveProject`, `apiProjectInits`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/web/router.ts` | `backend/src/server.ts` (prefixed route map, `server.reload()`, `ws.data.prefix` dispatch) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/commands/project.ts` | `bin/src/project-commands.ts` (`ls`/`add`/`rm`, `awaitProjectSetup`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/commands/serve.ts` | `backend/src/server.ts` (bootstrap order, `autoAddCwd`) + `WEBMUX_PROJECT_DIR` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/public/app.js` (project selector, "Trabalho ativo") | `frontend/src/lib/ProjectSwitcher.svelte` (project switcher) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/sandbox/docker.ts` | `backend/src/adapters/docker.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/sandbox/Dockerfile.sandbox.full` | `sandbox-image/Dockerfile.sandbox` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/sandbox/entrypoint.sh` | `sandbox-image/entrypoint.sh` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/reconcile.ts` | `backend/src/services/reconciliation-service.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/reconcile.ts` (open-session snapshot) | `backend/src/services/session-restore-service.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/profiles.ts` | `backend/src/adapters/config.ts` (profiles/panes/mounts parsers, `expandTemplate`, `getDefaultProfileName`, `isDockerProfile`) + `domain/config.ts` (`ProfileConfig`, `PaneTemplate`, `MountSpec`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/config/runtime.ts` | `backend/src/adapters/config.ts` (`loadConfig`, local overlay merge, `parseStartupEnvs`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/services.ts` | `backend/src/adapters/port-probe.ts` (`BunPortProbe`) + `domain/policies.ts:96` (`allocateServicePorts`) + `adapters/config.ts` (`parseServices`) + `services/reconciliation-service.ts` (`buildServiceStates`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/sandbox/docker.ts` (`--cap-drop`, `no-new-privileges`, `--pids-limit`, `--memory`, `--network`, `SandboxSecurityConfig`, `isSecretLikeEnvKey`, `isDockerSocketPath`) | none — no upstream counterpart; §14 stage 2 of the absorption plan | — | — | NEW | — |
| `packages/issue-flow/sandbox/Dockerfile.sandbox` (minimal default image) | `sandbox-image/Dockerfile.sandbox` (reduced: Rust, asciinema, Bun, Playwright, AWS CLI, Mermaid CLI and `sudo` removed) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/core/run-completion.ts` | `backend/src/services/oneshot-watcher-service.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (sem LICENSE) |
| `packages/issue-flow/src/commands/run/auto-close.ts` | `backend/src/services/oneshot-watcher-service.ts` (`closeWorktree`/`disarmOneshot`) + `services/lifecycle-service.ts:674` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (sem LICENSE) |
| `packages/issue-flow/src/commands/run/demand.ts` | `bin/src/oneshot.ts` (`parseOneshotArgs`, `--prompt`, `--keep-open`) | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (sem LICENSE) |
| `packages/issue-flow/src/issues/providers/inline.ts` | `bin/src/oneshot.ts` (prompt livre como entrada; `CreateWorktreeRequest.prompt`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (sem LICENSE) |
| `packages/issue-flow/src/storage/db/inline-issues.ts` | `backend/src/adapters/fs.ts` (`meta.oneshot` como persistência da demanda) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (sem LICENSE) |
| `packages/issue-flow/src/config/run.ts` | `bin/src/oneshot.ts` (`oneshot: { autoCloseOnDone }` no corpo da requisição) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (sem LICENSE) |
