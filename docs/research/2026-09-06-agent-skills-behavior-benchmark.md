# Agent Skills benchmark

Created: 2026-09-06T03:52:09.104Z

Baseline: 62d07e1

| Provider | Arm | Surface | Kind | Pass | Errors | Duration ms | Tokens | Tool calls |
|---|---|---|---|---:|---:|---:|---:|---:|
| codex | without-skill | skill | behavior | 100.0% | 0 | 57142 | 20024.50 | 6 |
| codex | baseline | skill | behavior | 100.0% | 0 | 70228 | 23965 | 8 |
| codex | candidate | skill | behavior | 100.0% | 0 | 68127.50 | 35637.50 | 9 |

## Comparisons

- codex skill/behavior, baseline → candidate: pass 100.0% → 100.0%; duration 70228 → 68127.50 ms; tokens 23965 → 35637.50.
- codex skill/behavior, without-skill → candidate: pass 100.0% → 100.0%; duration 57142 → 68127.50 ms; tokens 20024.50 → 35637.50.
