# Agent Skills benchmark

Created: 2026-09-06T03:37:52.851Z

Baseline: 62d07e1

| Provider | Arm | Surface | Kind | Pass | Errors | Duration ms | Tokens | Tool calls |
|---|---|---|---|---:|---:|---:|---:|---:|
| codex | baseline | skill | positive | 100.0% | 0 | 7381.36 | 9380.18 | 0 |
| codex | baseline | skill | negative | 100.0% | 0 | 7034.55 | 9371 | 0 |
| codex | candidate | skill | positive | 100.0% | 0 | 6645.09 | 9377.64 | 0 |
| codex | candidate | skill | negative | 100.0% | 0 | 6562.82 | 9374.82 | 0 |
| cursor | baseline | skill | positive | 100.0% | 0 | 11835.64 | n/a | 0 |
| cursor | baseline | skill | negative | 100.0% | 0 | 13225.45 | n/a | 0 |
| cursor | candidate | skill | positive | 100.0% | 0 | 11916.36 | n/a | 0 |
| cursor | candidate | skill | negative | 100.0% | 0 | 13378.64 | n/a | 0 |

## Comparisons

- codex skill/positive, baseline → candidate: pass 100.0% → 100.0%; duration 7381.36 → 6645.09 ms; tokens 9380.18 → 9377.64.
- codex skill/negative, baseline → candidate: pass 100.0% → 100.0%; duration 7034.55 → 6562.82 ms; tokens 9371 → 9374.82.
- cursor skill/positive, baseline → candidate: pass 100.0% → 100.0%; duration 11835.64 → 11916.36 ms; tokens n/a.
- cursor skill/negative, baseline → candidate: pass 100.0% → 100.0%; duration 13225.45 → 13378.64 ms; tokens n/a.
