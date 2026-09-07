# Configuration loaders

One file per configuration domain under `src/config/`, with `src/config.ts` as
a façade that re-exports the public surface. See
[`docs/configuration.md`](../../../../docs/configuration.md) for the
precedence ladder and environment variables, and
[`docs/code-organization.md`](../../../../docs/code-organization.md) for size
and move-vs-change rules.

## Layout

| File | Responsibility |
|---|---|
| `../config.ts` | Façade only — re-exports. No loader logic. |
| `layers.ts` | `ConfigLayers`, `mergeConfigLayers`, `dropNullish`, `parseBooleanEnv`, `readNumberEnv` |
| `sources.ts` | Project / global file readers (`PROJECT_CONFIG_FILENAME`, `loadGlobalConfig`, …) |
| `engine.ts` | `DEFAULTS`, `createConfig`, `resolvePaths` |
| `dependencies.ts` | `getInstallHint`, `validateDependencies` |
| `web.ts`, `issues.ts`, `pr-review.ts`, `github.ts`, `linear.ts`, `auto-name.ts`, `policy.ts`, `telemetry.ts`, `resilience.ts`, `agent.ts`, `verify.ts`, `routing.ts` | One domain each: `load*`, `read*`, `set*CliOverrides`, mutable module state |
| `custom-agents.ts` | Global/project custom-agent registry, tombstones and serialized atomic project writes |
| `project-settings.ts` | Serialized read-modify-write shared by dashboard-owned project toggles |

## Dependency direction

```
config.ts  →  every module under config/
domain.ts  →  layers.ts, sources.ts   (only)
domain.ts  ↛  other domain.ts
domain.ts  ↛  config.ts
```

- Domains never import each other and never import the façade.
- Shared helpers live in `layers.ts` / `sources.ts` only.
- Exception: `dependencies.ts` imports `loadAgentConfig` from `agent.ts` for
  preflight. That is infrastructure → agent, not domain ↔ domain. Do not use it
  as a precedent for domain cross-imports.

A forced `loadLayered()` abstraction was evaluated after the split and
**discarded**: the loaders share the precedence idea but differ enough in
nested merges (policy, telemetry, resilience, agent, routing) that a common
helper would contort more than it would remove. Prefer `mergeConfigLayers` plus
domain-local readers.

`custom-agents.ts` is the deliberate exception in shape, not direction: it
layers entries **by id**, and a project `null` masks an inherited global agent.
Its read-modify-write must stay under `withSerializedFileLock` and end in
`writeFileAtomic`; otherwise two editor requests can each preserve every other
config key and still lose one another's agent update.

`linear.ts` persists behaviour only. `LINEAR_API_KEY` is read directly from the
supplied process environment and must never enter a config object or file.
Linear/GitHub toggles share `updateProjectConfigSection`; an environment-pinned
toggle is rejected by the web route instead of pretending the lower rung won.
`auto-name.ts` only resolves the policy consumed by the canonical
`conventions/git/auto-name.ts`; it does not generate names itself.

## Mutable CLI / process state

Each `set*CliOverrides` and its module-level variable stay in that domain's
file. `cachedAgentConfig` invalidation stays next to `setAgentCliOverrides` in
`agent.ts`. `get/setActiveResilienceConfig` and `initResilienceConfig` stay in
`resilience.ts`.

## Adding a domain

1. Create `src/config/<name>.ts` with the section key, env mapping, schema parse,
   `load*Config`, and (if needed) `set*CliOverrides` + module state.
2. Import only from `./layers.js`, `./sources.js`, and non-config packages
   (`schemas`, `storage`, …).
3. Re-export the public symbols from `src/config.ts`.
4. Add `src/config/<name>.test.ts` colocated with the loader.
5. Document the new env / JSON keys in `docs/configuration.md`.
6. Keep the file under ~350 lines; keep the façade under ~150 lines.

## Deprecations

`WEB_CONFIG_FILENAME` on the façade is `@deprecated` — use
`PROJECT_CONFIG_FILENAME`.
