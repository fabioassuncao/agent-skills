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
| `packages/issue-flow/src/agents/custom.ts` | `backend/src/services/agent-service.ts` (custom agents; templates adapted to argv plus out-of-band environment references) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/terminal/input.ts` | `backend/src/adapters/terminal.ts` (`sendPrompt`, `interruptPrompt`, `sendKeys`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/` | `backend/src/domain/model.ts` (`WorktreeConversationMeta`) + `adapters/session-discovery.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/terminal/attach.ts` | `backend/src/adapters/terminal.ts` (`attach`, `buildAttachCmd`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/terminal/pty.ts` | `backend/src/adapters/terminal.ts` (`detectPtyWrapper`, `buildPtyArgs`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/terminal/scrollback.ts` | `backend/src/adapters/terminal.ts` (scrollback ring) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/web/terminal-ws.ts` | `backend/src/server.ts` (WS handlers, `sendWs`); project-prefix dispatch adapted to the Issue Flow multi-project router | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
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
| `packages/issue-flow/src/commands/serve.ts` | `backend/src/server.ts` (bootstrap order, `autoAddCwd`, network URLs and lifecycle reporting) + `WEBMUX_PROJECT_DIR` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
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
| `packages/issue-flow/src/core/run-completion.ts` | `backend/src/services/oneshot-watcher-service.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/commands/run/auto-close.ts` | `backend/src/services/oneshot-watcher-service.ts` (`closeWorktree`/`disarmOneshot`) + `services/lifecycle-service.ts:674` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/commands/run/demand.ts` | `bin/src/oneshot.ts` (`parseOneshotArgs`, `--prompt`, `--keep-open`) | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/providers/inline.ts` | `bin/src/oneshot.ts` (prompt livre como entrada; `CreateWorktreeRequest.prompt`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/storage/db/inline-issues.ts` | `backend/src/adapters/fs.ts` (`meta.oneshot` como persistência da demanda) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/config/run.ts` | `bin/src/oneshot.ts` (`oneshot: { autoCloseOnDone }` no corpo da requisição) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/open.ts` | `backend/src/services/lifecycle-service.ts` (`createWorktree`, `openWorktree`, `resolveBranch`, `materializeRuntimeSession`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/open.ts` (`generateFreeSessionBranch`) | `backend/src/lib/branch-name.ts` (`generateFallbackBranchName`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/tty.ts` (`buildManagedShellCommand`) | `backend/src/services/agent-service.ts:198` (`buildManagedShellCommand`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/context.ts` | `backend/src/runtime.ts` (`createWebmuxRuntime`, per-project lifecycle wiring) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/commands/session.ts` | `bin/src/worktree-commands.ts` (`add`, `open`, `list`, `send`, `close`, `tab`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/web/sessions-api.ts` | `backend/src/server.ts` (rotas `worktrees`, `worktrees/:branch/prompt`, `worktrees/:branch/interrupt`, `DELETE worktrees/:branch`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/store.ts` (`linkSessionToRun`) | none — no upstream counterpart; the mode-2 → mode-1 promotion of §49.2 | — | — | NEW | — |
| `packages/issue-flow-contract/src/schemas.ts` | `packages/api-contract/src/schemas.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow-contract/src/contract.ts` | `packages/api-contract/src/contract.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow-contract/src/client.ts` | `packages/api-contract/src/client.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow-contract/src/capabilities.ts` | none — no upstream counterpart; the capability gate that ADR-10/`/api/health` require | — | — | NEW | — |
| `packages/issue-flow/web/index.html` | `frontend/index.html` + `frontend/src/lib/themes.ts` (prepaint recognizes all eight choices) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/vite.config.ts` | `frontend/vite.config.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/vitest.config.ts` | `frontend/vitest.config.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/svelte.config.js` | `frontend/svelte.config.js` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/main.ts` | `frontend/src/main.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/App.svelte` | `frontend/src/App.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/app.css` | `frontend/src/app.css` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/tokens.css` | `packages/issue-flow/web/public/app.css` (palette layer, verbatim; guarded by `tokens.test.ts`) | — | — | INTERNAL | — |
| `packages/issue-flow/web/src/lib/types.ts` | `frontend/src/lib/types.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/utils.ts` | `frontend/src/lib/utils.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/api.ts` | `frontend/src/lib/api.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/themes.ts` | `frontend/src/lib/themes.ts` (GitHub Dark, Dracula, Nord, Solarized Dark, One Dark; xterm derived from role tokens) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/tokens.css` (five named palette blocks) | `frontend/src/lib/themes.ts` (`ThemeDefinition.colors`, adjusted per role to pass the Issue Flow contrast contract) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/worktree-list.ts` | `frontend/src/lib/worktree-list.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/worktree-conversation.ts` | `frontend/src/lib/worktree-conversation.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/ask-user-question.ts` | `frontend/src/lib/ask-user-question.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/promptUtils.ts` | `frontend/src/lib/promptUtils.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/toast-context.ts` | `frontend/src/lib/toast-context.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/BaseDialog.svelte` | `frontend/src/lib/BaseDialog.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/Btn.svelte` | `frontend/src/lib/Btn.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/LinkBtn.svelte` | `frontend/src/lib/LinkBtn.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/Toggle.svelte` | `frontend/src/lib/Toggle.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/ConfirmDialog.svelte` | `frontend/src/lib/ConfirmDialog.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/ToastStack.svelte` | `frontend/src/lib/ToastStack.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/NotificationItem.svelte` | `frontend/src/lib/NotificationItem.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/CursorButton.svelte` | `frontend/src/lib/CursorButton.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/PrBadge.svelte` | `frontend/src/lib/PrBadge.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/PrStatusGroup.svelte` | `frontend/src/lib/PrStatusGroup.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/SidebarRepoRow.svelte` | `frontend/src/lib/SidebarRepoRow.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/RepoGroup.svelte` | `frontend/src/lib/RepoGroup.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/PaneBar.svelte` | `frontend/src/lib/PaneBar.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/TabBar.svelte` | `frontend/src/lib/TabBar.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/StartupEnvFields.svelte` | `frontend/src/lib/StartupEnvFields.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/AgentStatusIcon.svelte` | `frontend/src/lib/AgentStatusIcon.svelte` | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/AskUserQuestionCard.svelte` | `frontend/src/lib/AskUserQuestionCard.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/EmptyProjects.svelte` | `frontend/src/lib/EmptyProjects.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/ProjectSwitcher.svelte` | `frontend/src/lib/ProjectSwitcher.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/WorktreeLabelDialog.svelte` | `frontend/src/lib/WorktreeLabelDialog.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/WorktreeProfileDialog.svelte` | `frontend/src/lib/WorktreeProfileDialog.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/BranchSelector.svelte` | `frontend/src/lib/BranchSelector.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/AgentEditorDialog.svelte` | `frontend/src/lib/AgentEditorDialog.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/CommentReviewDialog.svelte` | `frontend/src/lib/CommentReviewDialog.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/CiDetailsDialog.svelte` | `frontend/src/lib/CiDetailsDialog.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/DiffDialog.svelte` | `frontend/src/lib/DiffDialog.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/Terminal.svelte` | `frontend/src/lib/Terminal.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/WorktreeList.svelte` | `frontend/src/lib/WorktreeList.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/TopBar.svelte` | `frontend/src/lib/TopBar.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/CreateWorktreeDialog.svelte` | `frontend/src/lib/CreateWorktreeDialog.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/SettingsDialog.svelte` | `frontend/src/lib/SettingsDialog.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/WorktreeConversationPanel.svelte` | `frontend/src/lib/WorktreeConversationPanel.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/MobileChatSurface.svelte` | `frontend/src/lib/MobileChatSurface.svelte` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/web/server.ts` (`loadDashboardAssets`) | none — no upstream counterpart; the WebMux server serves one frontend. The `/legacy/` mount ADR-18 required alongside it was removed in phase 8D, with §50.7 green (§50.8) | — | — | NEW | — |
| `packages/issue-flow/scripts/contract-install.mjs` | none — no upstream counterpart; the sibling-package install the two-zod split requires | — | — | NEW | — |
| `packages/issue-flow/src/agents/session/claude-stream.ts` | `backend/src/adapters/claude-cli.ts` (`parseClaudeStreamLine`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/claude.ts` | `backend/src/adapters/claude-cli.ts` (transcript, gateway, block identity) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/claude.ts` (`toClaudeConversationState`) | `backend/src/services/claude-conversation-service.ts` (`normalizeSessionMessages`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/core/stream.ts` (delegação do parsing) | `backend/src/adapters/claude-cli.ts` | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/codex.ts` | `backend/src/adapters/codex-app-server.ts` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/codex-conversation.ts` | `backend/src/services/worktree-conversation-service.ts:110-545` (metade pura) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/export.ts` | `backend/src/services/conversation-export-service.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/conversation.ts` | none — espelho local de `packages/api-contract` `AgentsUiConversationMessage`, definido aqui enquanto `src/` não depende de `@issue-flow/contract` | — | — | NEW | — |
| `packages/issue-flow/src/runtime/interactive.ts` | `backend/src/services/lifecycle-service.ts` (`materializeRuntimeSession`, `buildSessionLayout` — o caminho `host`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/sandbox.ts` | `backend/src/services/lifecycle-service.ts` (o mesmo par, ramo `runtime: docker`, e `requireDockerProfile`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/tty.ts` (`buildDockerExecCommand`, `buildDockerShellCommand`, `SANDBOX_PATH_ENTRIES`) | `backend/src/services/agent-service.ts` (`buildDockerExecCommand`, `buildDockerShellCommand`, `DOCKER_PATH_FALLBACK`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/event-queue.ts` | none — extração do helper privado de `runtime/headless.ts`, que os três modos passaram a precisar (§25) | — | — | NEW | — |
| `packages/issue-flow/src/runtime/types.ts` (`RuntimeSessionBinding`) | `backend/src/domain/model.ts` (`WorktreeMeta.runtime` + o `containerName` que o upstream carrega no fluxo) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `docs/runtime.md` | none — o documento que `§36` pede para os três modos; o upstream tem um modo só e nenhum equivalente | — | — | NEW | — |
| `packages/issue-flow/web/src/lib/{format,vocabulary,snapshot,executions,contrast}.ts` | none — `web/public/app.js` do próprio Issue Flow (formatação, glossário, leitura defensiva do snapshot, regras de visão, contraste). O upstream não tem execuções, nem `session.json` retrocompatível, nem paleta medida | — | — | NEW | — |
| `packages/issue-flow/web/src/lib/{ExecutionHeader,ExecutionAlerts,ExecutionTabs,NowBlock,ContextBlock,ProgressBlock,OutputBlock,KanbanBoard,HistoryList,ExecutionDrawer,ExecutionCard,ExecutionsDashboard,ExecutionPanel,ExecutionSidebarList,RefreshSelect,VerificationVerdictCard,PreferenceForms}.svelte` | none — porte de `web/public/{index.html,app.js,app.css}` do Issue Flow para Svelte 5 sobre a casca do WebMux (ADR-18). Não há contraparte upstream: o WebMux não tem execução, fases, user stories, Kanban, drawer nem verificação | — | — | NEW | — |
| `packages/issue-flow/web/src/lib/AgentStatusIcon.svelte` (`executionStatusToAgentStatus`, papéis de estado) | `frontend/src/lib/AgentStatusIcon.svelte` | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/{PrBadge.svelte,utils.ts}` (`PrBadgeInput`, `state: null`) | `frontend/src/lib/PrBadge.svelte` + `frontend/src/lib/utils.ts` | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/core/awaiting-input.ts` | none — a última linha da tabela de `§32` (`awaiting_input` sem resposta → notificação + escalada). O upstream desarma o oneshot no input humano e não tem o caso inverso | — | — | NEW | — |
| `packages/issue-flow/web/{measure.html,src/measure.ts}` | none — bancada de medição de U6/U19/U20 em navegador real, que `happy-dom` não consegue medir | — | — | NEW | — |
| `packages/issue-flow/src/web/worktrees-api.ts` (listing, mutations, branches, diff, pull-main, project config and service URLs expanded from the effective launch environment) | `backend/src/server.ts` (`apiCreateWorktree`, delete/open/close/archive/label/profile/send/merge/diff/pull-main/list branches) + `backend/src/services/lifecycle-service.ts` | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/session/worktree-control.ts` | `backend/src/services/lifecycle-service.ts` + `backend/src/server.ts` (create/open/close/merge/remove/archive/profile orchestration) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/worktree/branches.ts` | `backend/src/server.ts` (`apiListBranches`, `apiListBaseBranches`) | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/storage/db/{migrations,repository}.ts` + `src/storage/schemas.ts` (`worktrees.archived`) | `backend/src/domain/model.ts` (`WorktreeMeta.archived`) + `backend/src/adapters/fs.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow-contract/src/{schemas,contract}.ts` (worktree mutation contract) | `packages/api-contract/src/{schemas,contract}.ts` (worktree routes) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow-contract/src/capabilities.ts` (`worktrees:mutate`) | none — granular capability required by the ADR-10 gate | — | — | NEW | — |
| `packages/issue-flow/web/src/App.svelte` (worktree mutation dialogs and shortcut wiring) | `frontend/src/App.svelte` + worktree dialogs/actions | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/config/custom-agents.ts` | `backend/src/domain/config.ts` (custom-agent definitions) + `backend/src/adapters/config.ts` (global/project layering) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/agents/custom-registry.ts` | `backend/src/services/agent-registry.ts` (built-in/custom listing and capabilities) | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/web/agents-api.ts` | `backend/src/server.ts` (agent CRUD/validation routes) + `backend/src/services/agent-validation-service.ts` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow-contract/src/capabilities.ts` (`agents:read`, `agents:write`) | none — separate read/write promises required by the ADR-10 loopback gate | — | — | NEW | — |
| `packages/issue-flow/src/cli-help.ts` + `src/cli.ts` (root help) | `bin/src/webmux.ts` (`usage()`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/ui/logger.ts` (`formatSubsystemLine`, `printSubsystem`) | `backend/src/lib/log.ts` (timestamp) + `bin/src/webmux.ts` (`[BE]` prefixing) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/commands/worktree.ts` + `src/cli.ts` (`worktree` namespace) | `bin/src/worktree-commands.ts` (`list`, archive/unarchive/label/remove/merge/prune) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/worktree/lock.ts` | none — durable cross-process exclusion around the shared mutation domain | — | — | NEW | — |
| `packages/issue-flow/src/issues/linear/client.ts` | `backend/src/services/linear-service.ts` (assigned issues, create/find issue, upload/attachment/comment) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/linear/auto-create.ts` | `backend/src/services/linear-auto-create-service.ts` (ticket selection and pickup) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/linear/conversation.ts` | `backend/src/services/conversation-export-service.ts` (structured conversation export to Linear) | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/config/{linear,auto-name,project-settings}.ts` + `src/config/github.ts` (auto-remove toggle) | `backend/src/adapters/config.ts` (Linear/GitHub/auto-name project config and persistence) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/web/integrations-api.ts` + `src/web/server.ts` (five integration routes) | `backend/src/server.ts` (`apiGetLinearIssues`, Linear auto-create/post, GitHub auto-remove, project auto-name handlers) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/commands/serve.ts` (Linear pickup and GitHub GC maintenance cadence) | `backend/src/services/linear-auto-create-service.ts` + `auto-remove-service.ts` (headless timers) | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/issues/github/pr.ts` (`fetchBranchPullRequestStates`, `headRefOid`) | `backend/src/services/auto-remove-service.ts` + `pr-service.ts` (merged-branch evidence) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/Linear{Panel,Badge,DetailDialog,PostDialog}.svelte` | `frontend/src/lib/Linear{Panel,Badge,DetailDialog,PostDialog}.svelte` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow-contract/src/{schemas,contract,capabilities}.ts` (Linear/settings/auto-name contract) | `packages/api-contract/src/{schemas,contract}.ts` (Linear and project integration routes) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/{utils.ts,SettingsDialog.svelte,CursorButton.svelte}` (SSH host → Cursor URL) | `frontend/src/lib/{utils.ts,SettingsDialog.svelte,CursorButton.svelte}` | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/web/src/lib/contrast.test.ts` (all explicit themes, including 95 new Chromium measurements) | none — Issue Flow's in-page contrast gate | — | — | INTERNAL | — |
| `packages/issue-flow/web/src/lib/WorkspaceBlock.svelte` | none — a aba "Sessões e worktrees" de §50.5. O upstream lista worktrees na barra lateral e não tem o conceito de uma Task que os contém | — | — | NEW | — |
| `packages/issue-flow/web/src/lib/ReviewBlock.svelte` | `frontend/src/lib/CommentReviewDialog.svelte` (a metade de comentários de PR) | windmill-labs/webmux | d8c9d5f | MERGE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/commands/serve.ts` (fiação de `terminal` e do monitor de PR/CI) | `backend/src/server.ts` (o boot que liga transporte e display sync) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow-contract/src/capabilities.ts` (`sessions`, `session:open`) | none — a divisão de `worktrees` que a Fase 8D exigiu: listar e mutar são promessas diferentes | — | — | NEW | — |
| `packages/issue-flow/web/src/lib/api.ts` (`openSession`, `stopSession`, `linkSession`, `fetchAgentSessions`) | none — os verbos de `§49.3`, que o upstream não tem porque não tem o conceito de sessão sem worktree nomeada | — | — | NEW | — |
| `packages/issue-flow/src/agents/session/tabs.ts` | `backend/src/services/{lifecycle-service,tab-logic}.ts` (create/select/delete/restore tabs and monotonic fork numbering) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/tmux/{gateway,names}.ts` (`createParkedPane`, `swapPanes`, `movePaneToWindow`, strict pane identity and owner tags) | `backend/src/adapters/tmux.ts` (`createParkedPane`, `swapPanes`, `killPane`, parking naming) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/storage/db/{migrations,repository}.ts` (migration 22, atomic tab creation/activation) | `backend/src/domain/model.ts` (`tabs`, `activeTabId`, `forkCounter`) + `backend/src/adapters/fs.ts` (`backfillTabs`) | windmill-labs/webmux | d8c9d5f | REPLACE | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/web/worktrees-api.ts` (tab and non-destructive refresh routes) | `backend/src/server.ts` (`apiCreateWorktreeTab`, `apiSelectWorktreeTab`, `apiDeleteWorktreeTab`, `apiRefreshWorktreeAgentTerminal`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow-contract/src/{schemas,contract}.ts` (worktree tabs and terminal refresh) | `packages/api-contract/src/{schemas,contract}.ts` (same tab routes and `WorktreeTabSchema`) | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (no LICENSE) |
| `packages/issue-flow-contract/src/capabilities.ts` (`worktrees:tabs`, `terminal:refresh`) | none — granular loopback promises required by ADR-10 | — | — | NEW | — |
| `packages/issue-flow/web/src/{App.svelte,lib/TabBar.svelte,lib/api.ts}` (reachable Root/forks and recovery) | `frontend/src/{App.svelte,lib/TabBar.svelte,lib/api.ts}` | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/commands/tab.ts` + `src/commands/worktree.ts` (`refresh`) | `bin/src/worktree-commands.ts` (`tab`, `refresh`) | windmill-labs/webmux | d8c9d5f | ADAPT | package.json: MIT (no LICENSE) |
| `packages/issue-flow/src/runtime/terminal/attach.ts` + `src/web/terminal-ws.ts` (attach to authenticated active tab) | none — the upstream attaches by branch/window and has no durable AgentSession owner token | — | — | NEW | — |
