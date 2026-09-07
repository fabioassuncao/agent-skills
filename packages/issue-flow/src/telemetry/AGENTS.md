# Telemetry rules

Execution telemetry is persisted in SQLite and describes how work was
produced. It never changes the result of the work itself.

- `recorder.ts` is the execution writer. Callers begin and end an execution;
  they do not update execution rows directly.
- `tasks.json` is an agent-facing task-plan projection. Telemetry must not
  read-modify-write it while an agent owns the file.
- Running records are written before spawn and finalized after exit. A process
  that disappears can be reconciled to `interrupted` using the shared liveness
  rules.
- Failure text is redacted. Do not persist prompts, secrets, or complete model
  output.
- Cost is a discriminated union: reported, estimated, or unknown. Estimation is
  opt-in and records the rates used.
- Provider, harness, requested model, and resolved model come from the runner;
  they are not inferred from argv or log text.
- Timing fields are optional measurements. Absence means not reported, never
  zero.
- Verification verdicts attach to the relevant execution; independent review
  uses `purpose: verify`.
- CLI reports query SQLite directly and derive summaries at read time.
- Git artifacts never depend on telemetry.

Configuration uses the normal precedence ladder. Supported telemetry keys are
`enabled`, `pricing.estimate`, and `pricing.overrides`.
