# Harness latency baseline — before table

> **Research document.** Collected **2026-08-30** on macOS, Node v22.22.1,
> `claude` CLI **2.1.251**. This is the **before** table of [#79](https://github.com/fabioassuncao/issue-flow/issues/79).
> Phases 3–4 (quick wins and structural changes) belong to [#89](https://github.com/fabioassuncao/issue-flow/issues/89)
> and must not be decided here.

`time-to-accepted-result` is the headline metric. These rows predate the
acceptance contract of [#85](https://github.com/fabioassuncao/issue-flow/issues/85),
so every verdict is `unverified`. Do not mix them with later `passed` rows.

Every comparable row must carry the full tuple **plus both versions**:

```text
tarefa × harness × harnessVersion × modelo × modelVersion × esforço × verificação × estratégia
```

`claude-code + modelo M` and `codex-cli + modelo M` are different execution
targets.

## Flags that invalidate a row

| Flag | Rule |
|---|---|
| `--setting-sources` | Pin it. A measurement that loads the operator's personal MCP/settings is not reproducible in CI. MCP alone cost ~2.25s and ~4.3k tokens per invocation in this investigation. |
| `--fallback-model` | **Do not pass it** in `real` mode. If it fires, the model that ran is not the measured one and the envelope does not record the switch. |
| `--strict-mcp-config` | A #89 quick win. The numbers below are **without** it, matching what the pipeline does today. |

## Medição A — startup of `claude -p`

Prompt trivial (`"Responda apenas: OK"`), `--max-turns 1`, `--output-format json`.

| Variante | Wall clock | `duration_ms` | Startup invisível (`harnessStartupMs`) | Contexto base | Custo |
|---|---|---|---|---|---|
| padrão (como o Issue Flow chama hoje) | **5,58s** | 1.948ms | **~3,63s** | 29.750 tokens | $0,2012 |
| `--strict-mcp-config` | **3,57s** | 2.194ms | ~1,38s | 25.408 tokens | $0,1265 |
| `--bare` | 0,80s | — | — | — | falha (`rc=1`) |

The CLI does not see its own startup. Instrumentation that trusts only the
envelope underestimates the real cost.

## Medição B — telemetria real da issue #63 (p50 ≈ valor único)

Snapshot of a live run from SQLite (22 User Stories, 3 iterations done). A
single observation is both p50 and p95 until `real` mode collects N repeats.

| Classe (aprox.) | Fase | Wall (s) | Output tokens | tok/s | Custo | Estratégia |
|---|---|---|---|---|---|---|
| analysis | `prd` | 304 | 26.424 | 86,9 | $1,862 | pipeline |
| analysis | `plan` | 155 | 13.458 | 86,8 | $1,191 | pipeline |
| medium | `execute` US-009 | 541 | 34.160 | 63,1 | $3,175 | pipeline, 1 story / sessão |
| medium | `execute` US-010 | 494 | 35.047 | 70,9 | $2,905 | pipeline, 1 story / sessão |

Totais até a terceira iteração: **1.548s** e **$9,13**. Correlação: duração ≈
outputTokens / ~85 tok/s (cai para 63–71 tok/s em `execute` por round-trips).

## Pipeline × direto — o que esta investigação já separou

| Classe | Pipeline (Issue Flow) | Direto (`claude -p`) | Overhead de orquestração |
|---|---|---|---|
| trivial (1 prompt, 1 turn) | ~5,58s (mesmo argv da CLI) | ~5,58s | ~0 — o custo é o startup da CLI |
| small / medium (1 User Story) | 9–17 min (relatos) / 494–541s medidos | fração disso numa sessão quente | **~1,3%** do wall (startup + `sleep(2)` + git/gh) |
| analysis (`prd`/`plan`) | 304s / 155s | não isolado nesta coleta | tokens de saída dominam |

O overhead de orquestração estimado para 22 iterações é
22 × (3,6s startup + 2s sleep + 1,0s git/gh) ≈ **145s**, ou **~1,3%** de ~3 h.
O gargalo é a **forma** do pipeline (uma sessão fria por story), não o
orquestrador.

## Orçamentos derivados (não arbitrados)

```text
orchestrationOverhead mediano  <  5% do taskDuration
harnessStartupMs p95           <  2s por invocação   # hoje ~3,6s — meta da #89
overhead absoluto por iteração <  5s
```

O synthetic em CI trava regressão do reducer e do parse do snapshot
(`src/benchmark/synthetic.ts`). Ele não substitui a tabela `real`.

O instrumento que coleta a tabela `real` é `issue-flow bench --mode real`
(#90): fixtures descartáveis, N repetições, p50/p95, tupla de
comparabilidade e `ISSUE_FLOW_HOME` isolado. Ver
[`src/benchmark/AGENTS.md`](../../packages/issue-flow/src/benchmark/AGENTS.md).

## O que esta baseline deliberadamente não muda

`--strict-mcp-config`, remoção do `sleep(2)`, `gh pr list` só em fronteira de
fase, `storiesPerIteration`, ritual condicional e validação proporcional
ficam na **#89**. Esta issue só mede.
