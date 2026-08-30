# src/routing

Shadow-first selection. The router is the lowest rung of the agent
ladder: it never overrides an explicit `agent.phases` / `--agent`.

## Invariants

- **Default is `shadow`.** Decide, record `selected` and `actual`, change
  nothing. No terminal output in non-verbose mode.
- **`off` records nothing.**
- **No I/O.** Classification, filter and score are pure. History arrives
  ready-made from the caller.
- **No chain-of-thought.** Persist `reasonCodes`, priors, scores. Never
  free text from a model.
- **Permission is not a score dimension.** A candidate never becomes more
  permissive than the configured phase.
- **Cost `unknown` does not score cost.** `{ unknown }` is not `$0`.
- **`active` (stage 3) applies only where nothing was configured.**
- **Escalation lives here, not in `resilience/`.** Default `enabled: false`
  and every ceiling `null`. `detectNonConvergence()` reads `CheckResult`
  ids, never error text. The ladder only climbs. `provider_down` never
  enters it. A ceiling is `blocked`, left only by `actor: 'human'`.
  Cost `unknown` does not consume the cost ceiling.
