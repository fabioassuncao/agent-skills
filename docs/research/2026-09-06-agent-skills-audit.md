# Auditoria e refactor das Agent Skills

Data: 2026-09-06
Baseline: `62d07e1`
Escopo: Agent Skills, autoria/geração, triggering, evals, Ralph Loop e prompts da CLI.

Este documento registra evidência e decisões desta execução. As regras normativas
continuam em [skills.md](../skills.md), [skills-evals.md](../skills-evals.md),
[code-organization.md](../code-organization.md), [resilience.md](../resilience.md)
e [verification.md](../verification.md).

## Resultado arquitetural

O desenho atual já tem uma fronteira correta e foi preservado:

```text
autoria                                           distribuição/runtime
skills-src/{<skill>,_shared,manifest.json} ─┐
packages/issue-flow/prompts-src/ ───────────┼─ skills:sync ─┬─ skills/<skill>/
packages/issue-flow/src/ + skill-entries/ ──┘               └─ prompts/*.md

skills/<skill>/ ── agente atual, sem CLI obrigatória
prompts/*.md + src/ ── CLI independente, com adapters de agentes
```

- `skills-src/` é a fonte de verdade das onze Skills. `SKILL.md.in`,
  `workflow.md`, `_shared/` e `manifest.json` são editados manualmente.
- `skills/` é a distribuição gerada, autocontida e versionada. Ela existe para
  instalação direta e não é uma segunda fonte de verdade.
- `prompts-src/` é a fonte dos oito templates da CLI. `prompts/` é o output
  gerado e empacotado.
- `src/` é a fonte de regras puras que realmente precisam ser executáveis nos
  dois consumidores. Entrypoints em `scripts/skill-entries/` as empacotam para
  as Skills sem criar dependência de runtime.
- `_shared/` evita cópias autorais de contratos com paridade real. O manifest
  materializa cópias por Skill para manter a distribuição independente.
- O builder único resolve contratos, gera a tabela fixa do workflow, empacota
  helpers e escreve proveniência. `skills:check` compara bytes e file sets, de
  modo que edição acidental ou drift falha antes de um novo build ocultá-lo.

Não há dois sources of truth para o mesmo conteúdo conceitual nas áreas
auditadas. Existe duplicação física intencional nos artefatos instaláveis. Os
prompts continuam separados das Skills quando a operação é específica da CLI;
contratos pequenos são compartilhados somente quando a semântica é idêntica.

## Skill Creator oficial

Foram inspecionados o entrypoint, agentes de avaliação, referências, scripts,
schemas, benchmark, viewer e otimizador de description do
[Skill Creator oficial](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator).
A implementação oficial usa recursos do Claude Code para automatizar partes do
seu ciclo, mas seus princípios de engenharia não dependem desses recursos.

| Prática | Problema que resolve | Situação no Issue Flow | Decisão | Mudança realizada |
|---|---|---|---|---|
| Metadata curta e orientada a trigger | Seleção ocorre antes de carregar o corpo | Descriptions já tinham limites claros, mas quatro perdiam intenções implícitas | Adaptar | `analyze-issue`, `generate-prd`, `execute-tasks` e `resolve-issue` ganharam vocabulário de intenção e mantiveram negativos explícitos |
| `SKILL.md` como mapa e workflow | Evita despejar conhecimento raro no contexto | Entrypoints tinham 32–54 linhas e references condicionais | Adotar o padrão existente | Boilerplate foi reduzido; cada entrypoint continua apontando para uma procedure e recursos condicionais |
| References carregadas por necessidade | Progressive disclosure | Já implementado, inclusive uma fase por vez em `resolve-issue` | Manter | Nenhuma fragmentação artificial; todos os recursos continuam alcançáveis diretamente |
| Scripts para operações determinísticas | Reduz custo e erro em parsing/validação | Hash, schemas, naming, scaffold e inspeção do plano já são código puro empacotado | Manter | Nenhuma regra semântica foi convertida em código; helpers continuam executados, não lidos no contexto |
| Evals com baseline e repetição | Distingue percepção de regressão mensurável | Runner aceitava um SHA, mas não agregava braços nem variância | Adotar | Novo `skills:benchmark` compara candidate, baseline e no-Skill, com repetição e estatística |
| Métricas de tokens, tempo e qualidade | Torna trade-offs visíveis | Evidência por caso existia, sem resumo comparativo | Adotar | Médias, desvio-padrão amostral, mínimo/máximo, pass rate, erros e tool calls em JSON + Markdown |
| Positivos e negativos realistas | Evita over/under-triggering | Havia um par simples por Skill | Adotar | 22 casos holdout novos: intenção implícita e near-neighbor/overlap para cada Skill |
| Holdout separado do conjunto usado na edição | Reduz ajuste ao próprio teste | Não havia split | Adotar | Campo opcional `split`, validado como `development` ou `holdout` |
| Comparador qualitativo/visual | Ajuda a julgar outputs abertos | Rubricas e `manualReview` já registram o limite | Adaptar | Mantida revisão humana em JSON/Markdown; não foi adicionado viewer web |
| Otimização automática de description com várias chamadas | Explora wording em escala | Onze Skills pequenas e corpus ainda em amadurecimento | Não adotar agora | Evitado loop caro e Claude-specific; descriptions mudam por evidência e holdout |
| Subagentes, commands e configuração `.claude/` | Automatizam o próprio Skill Creator | Quebrariam a portabilidade do core | Não adotar | Benchmark chama os adapters existentes da CLI; Skills não ganharam dependência proprietária |

O limite recomendado de corpo curto não exigiu cortes agressivos: todos os
entrypoints estão muito abaixo de 500 linhas. A redução aplicada remove contexto
sem retirar decisão, precondição ou output.

## Auditoria individual

Tokens nesta tabela são a aproximação reproduzível `ceil(caracteres / 4)`. A
coluna “instalado” soma todo Markdown disponível, não conteúdo carregado em toda
invocação. Cada Skill carrega inicialmente um `SKILL.md`; references permanecem
condicionais. Todas são autocontidas e nenhuma exige sibling Skill, subagente,
hook, MCP ou CLI.

| Skill | Responsabilidade e trigger | Entrada antes → depois | Todo Markdown antes → depois | Progressive disclosure, scripts e decisão |
|---|---|---:|---:|---|
| `analyze-issue` | Investigação/triagem antes da implementação | 474 → 459 | 5.208 → 5.304 | Procedure curta; input/policy conforme decisão; helper resolve o store sem CLI. Trigger passou a cobrir “investigate/triage”. |
| `generate-prd` | Requisitos, PRD ou product specification | 525 → 507 | 6.974 → 7.112 | Formato/evidência sob demanda; helper prepara o diretório selecionado. Evita overlap com conversão de PRD existente. |
| `convert-prd-to-json` | PRD existente para plano JSON ordenado | 544 → 517 | 8.238 → 8.395 | Plano e Git são referências separadas; schema/grafo ficam no helper, que valida e reconcilia `tasks.json`. |
| `execute-tasks` | Implementar/continuar `tasks.json` existente | 586 → 557 | 9.116 → 9.268 | Carrega evidência/completion no ponto de uso; inspeção e elegibilidade são determinísticas. Trigger explicita `tasks.json`. |
| `create-pr` | Criar/publicar PR de branch verificada | 540 → 526 | 8.950 → 9.048 | Metadados/publication entram só na mutação remota; naming e paths são helpers. Título corrigido para PR. |
| `review-issue` | Verificar issue resolvida contra código e checks | 546 → 532 | 6.180 → 6.278 | Evidência e protocolo estruturado separados; publicação só quando solicitada. Mantida distinta de análise e PR review. |
| `review-pr` | Revisar PR completa e merge readiness | 507 → 493 | 6.312 → 6.426 | Diff/evidência e protocolo conforme necessidade; relatórios usam o diretório resolvido. Título corrigido para PR. |
| `generate-issue` | Redigir e publicar item no GitHub | 557 → 543 | 7.566 → 7.663 | Authoring, publication e Git são condicionais; helper evita path local inventado. |
| `generate-local-issue` | Criar `issue.md`/`metadata.json` offline | 576 → 550 | 7.678 → 7.770 | Arquivos, hash e store são determinísticos; não depende de autenticação remota. |
| `init-repository` | Preencher apenas convenções/templates ausentes | 521 → 507 | 5.724 → 5.822 | Scaffold determinístico preserva plan-then-apply; helper fecha links compartilhados sem carregamento inicial. |
| `resolve-issue` | Orquestrar o fluxo completo no agente atual | 809 → 783 | 16.462 → 16.688 | Única Skill composta; lê uma fase por vez e mantém continuidade pelo store compartilhado. Trigger cobre “fix/implement”. |

Problemas comuns corrigidos: boilerplate inicial, títulos com siglas incorretas,
lacunas de vocabulário de trigger e paths divergentes entre interfaces. O
Markdown instalado cresceu porque todas as Skills receberam a regra comum de
storage; isso não aumenta o contexto inicial, pois scripts e references seguem
sob demanda. Não foram encontradas
references órfãs, imports externos nos bundles, paths que escapam da Skill ou
instruções que instalem silenciosamente a CLI.

## Consolidação das Skills

Nenhum merge foi implementado. A quantidade de diretórios não determina o
contexto: hosts carregam metadata do catálogo e, após seleção, o corpo da Skill
escolhida. Uma Skill maior aumentaria o corpo de invocações de uma única fase;
o caso realmente composto já é atendido por `resolve-issue`, com procedures
progressivas.

| Candidatas | Motivo investigado | Evidência | Decisão |
|---|---|---|---|
| `generate-prd` + `convert-prd-to-json` | Uso sequencial | Inputs/outputs e negativos são diferentes; 507 e 517 tokens de entrada isolada; `resolve-issue` já compõe ambos | Manter separadas |
| `review-issue` + `review-pr` | Ambas revisam | Objeto, protocolo e efeitos remotos diferem; holdout testa a fronteira nos dois sentidos | Manter separadas |
| `generate-issue` + `generate-local-issue` | Conteúdo semelhante | Destino, autenticação, deduplicação e artifacts diferem | Manter separadas |
| `create-pr` + `review-pr` | Mesmo objeto remoto | Criação é mutação autorizada; review é read-only | Manter separadas |
| `analyze-issue` + `review-issue` | Ambas inspecionam issue | Uma precede implementação; outra exige implementação e evidência frescas | Manter separadas |
| `execute-tasks` + `resolve-issue` | Ambas implementam | Fase existente versus orquestração completa; merge duplicaria `resolve-issue` em toda execução parcial | Manter separadas |

Não foi construído um candidato consolidado artificial, portanto não há números
honestos de qualidade/latência “depois” para um merge. A decisão conservadora
preserva modularidade porque não surgiu uma hipótese com ganho de contexto e
coesão suficiente para justificar chamadas pagas e uma possível quebra pública.

## Estrutura de diretórios

### Antes e depois

```text
ANTES                              DEPOIS
skills-src/                        skills-src/
  _shared/                           _shared/                # + contrato de contexto CLI
  <11 Skills>/                       <11 Skills>/
  manifest.json                      manifest.json           # + helper de artifacts
skills/ (gerado)                   skills/ (gerado)
  <11 Skills>/                       <11 Skills>/            # + scripts/artifacts.mjs

packages/issue-flow/               packages/issue-flow/
  prompts-src/                       prompts-src/             # fonte mantida
  prompts/ (gerado)                  prompts/ (gerado)
  src/storage/                       src/storage/             # + layout/seleção/identidade puros
  src/core/                          src/core/                # + parsers de resultados
  scripts/                           scripts/                # + benchmark e helper portátil
evals/skills/                      evals/skills/
  scenarios.json                    scenarios.json           # + holdout
```

`skills-src` e `prompts-src` ainda fazem sentido e continuam separados. O
primeiro está na raiz porque produz artefatos portáveis do repositório; o segundo
está no pacote porque só a CLI o consome. Renomear ambos para uma árvore
`authoring/` moveria muitos paths e adicionaria uma categoria abstrata sem reduzir
geração, duplicação ou runtime coupling. `_shared` comunica corretamente que são
fragmentos autorais copiados no build. A documentação responde “onde editar” e
“como gerar”; a proveniência responde isso dentro de cada output.

## Ralph Loop

Foram inspecionados commands, setup, Stop hook e estado do
[Ralph Loop oficial](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop).
O plugin persiste prompt, contador, limite e completion promise em
`.claude/ralph-loop.local.md`; o Stop hook lê o transcript, detecta a promise,
incrementa o estado de forma atômica e reinsere o mesmo prompt até concluir ou
atingir o máximo.

| Mecanismo Ralph | Equivalente no Issue Flow | Decisão |
|---|---|---|
| Iteração com feedback do workspace | `execute-tasks`, checks e `progress.txt`; CLI execute loop | Já existe; não duplicar |
| Estado persistido em arquivo | `tasks.json`, `session.json`, journal/SQLite | Já existe em formas portáteis e na CLI |
| Completion promise exata | `completion-signal.md` + verificação fresca | Já existe e é mais forte que texto isolado |
| Máximo de iterações | `maxIterations` e `maxCorrectionCycles` | Já existe |
| Recuperação e registro do que foi tentado | `lastError`, progress, journal e taxonomy de retry | Já existe |
| Detecção de falta de progresso | watchdog e decomposição após sinais convergentes | Já existe |
| Stop hook/transcript/slash commands | Lifecycle exclusivo do Claude Code | Rejeitado para o core |
| Repetir cegamente o prompt inicial | Pode conservar contexto obsoleto | Rejeitado; Issue Flow projeta estado atual e evidência |

A melhoria reaproveitada nesta execução foi de observabilidade: braços repetidos,
erros de harness separados e estado de benchmark persistido. O workflow principal
permanece Agent Skills + artifacts; a CLI permanece o orquestrador programático.

## Skills, commands, subagentes e CLI

| Mecanismo | Papel adequado |
|---|---|
| Agent Skills | Interface portátil principal para conhecimento, decisões e workflow no agente atual |
| CLI | Orquestração independente, estado, retry, routing, telemetry e execução headless |
| Commands/hooks | Atalhos opcionais de um host; nunca requisito do fluxo |
| Subagentes | Otimização opcional quando o host oferece; não fazem parte dos contratos das Skills |

A hipótese do projeto foi validada. Não foi criada uma camada genérica de
adapters para commands/hooks porque não existe consumidor concreto. Os adapters
Claude/Codex/Cursor/Antigravity já necessários para a CLI são reutilizados pelo
harness, sem vazar suas flags para as Skills.

## CLI e compartilhamento

Os prompts da CLI receberam a mesma separação entre julgamento do modelo e
trabalho determinístico aplicada às Skills. `analyze` e `prd` agora exigem um
único bloco final (`<issue-analysis>` ou `<prd>`); o comando valida e grava o
arquivo atomicamente. `plan` pede somente descrição, stories, critérios e chaves
de dependência em `<task-plan>`. IDs US-NNN, prioridade, branch, referência da
issue, flags de pipeline e lifecycle são preenchidos e validados em TypeScript.
O agente perdeu permissão de escrita nessas três fases.

O contexto de issue repetido em cinco templates passou a vir de
`_shared/cli-issue-context.md`. O bloco de correção do execute só é renderizado
quando existem findings pendentes, poupando 122 tokens estimados no caminho
normal. O contexto issue/PRD do PR review só entra quando uma issue foi
associada, poupando 101 tokens estimados no review avulso. Os oito prompts gerados
caíram de 13.314 para 12.863 tokens estimados (-451; -3,39%) contra o baseline
reproduzível deste relatório.

Foi compartilhado o que tem semântica comum: schemas, task graph, parsers,
naming, hashes, scaffold, layout/resolução de artifacts, contratos pequenos,
fixtures e adapters de benchmark. Permaneceram separados: lifecycle/state/retry
da CLI, procedures da Skill, placeholders da CLI e instruções específicas de
publicação/orquestração.

O store padrão é `~/.issue-flow/projects/<project-id>/issues/<id>/`. A existência
prévia de `<workspace>/.issue-flow/issues/` seleciona o store local completo para
CLI e Skills. Não há criação implícita do opt-in, cópia ou mistura de raízes. O
`.gitignore` local gerenciado cobre apenas artifacts operacionais; prompts e
outras configurações continuam versionáveis. `tasks.json` é a projeção de troca:
mudanças da Skill são validadas e reimportadas por SHA-256 na próxima resolução
da CLI; materializações da CLI atualizam o hash e ficam imediatamente legíveis
pela Skill. Sessões, locks e telemetry continuam exclusivos do runtime da CLI.

## Evals e métricas

O corpus passou de 80 para 102 cenários. Os 56 casos comportamentais foram
preservados e a seleção passou de 24 para 46 casos. Cada Skill agora tem no
mínimo quatro casos de seleção: explícito positivo, negativo, implícito holdout
e overlap holdout.

`skills-benchmark.mjs` implementa:

- candidate, Git baseline e no-Skill para behavior;
- múltiplos providers, um processo por provider por vez e providers em paralelo;
- corpus limitado por `--scenario`/`--split` e teto padrão de 120 invocações;
- repetições;
- ordem dos braços invertida em repetições alternadas para reduzir viés temporal;
- pass rate total e pass rate entre resultados avaliáveis;
- `HARNESS_ERROR` e `VERIFIER_ERROR` fora da falha funcional;
- duração, tool calls, input/output/cache tokens e custo quando reportados;
- média, desvio-padrão amostral, mínimo, máximo e deltas;
- JSON detalhado e resumo Markdown.

| Métrica estática | Antes | Depois | Resultado |
|---|---:|---:|---|
| Entry points, tokens estimados | 6.185 | 5.974 | -211 (-3,41%) |
| Todo Markdown instalado, tokens estimados | 88.408 | 89.774 | +1.366 (+1,55%); regras de store sob demanda |
| Arquivos carregados inicialmente após ativação | 1 | 1 | igual; references sob demanda |
| Prompts da CLI, tokens estimados | 13.314 | 12.863 | -451 (-3,39%) |
| Execute sem correction findings | 1.489 | 1.367 | -122 por execução normal |
| PR review sem issue associada | 2.981 | 2.880 | -101 por review avulso |
| Cenários de eval | 80 | 102 | +22 holdout |

| Critério | Atual (`62d07e1`) | Implementado | Resultado observado |
|---|---|---|---|
| Tokens | 6.185 tokens estimados de entrypoint; 13.314 nos prompts | 5.974 e 12.863 | entrypoint -3,41%; prompts -3,39%; live Skill end-to-end inconclusivo/negativo na amostra |
| Latência | sem benchmark Skill específico agregado | braços com média/desvio | candidate 3% mais rápido no behavior e misto no triggering; amostra insuficiente para claim |
| Qualidade | corpus sem holdout, baseline avaliado nos novos casos | holdout + behavior | 88/88 triggering e 6/6 behavior nos runs finais |
| Consistência | comparação manual por arquivos | arms e repetição com mesma fixture | melhora; hashes, erros e ordem alternada ficam registrados |
| Complexidade | um runner por caso | runner existente + um agregador pequeno | aumento localizado, compensado por substituir comparação manual |
| Manutenibilidade | descriptions sem near-neighbor obrigatório | validação exige holdout positivo/negativo por Skill | melhora |
| Portabilidade | eval live limitado a Claude/Codex | mesmos quatro adapters da CLI | melhora; Claude indisponível por quota e Antigravity não instalado nesta máquina |
| Testabilidade | 80 cenários | 102 + estatística testada | melhora |
| Discoverability | explícitos simples | intenção implícita e overlap | melhora, sem renomear Skills públicas |

O [benchmark de triggering](2026-09-06-agent-skills-trigger-benchmark.md)
executou 88 invocações sobre os 22 casos holdout, uma vez por braço/provider:

| Provider/casos | Baseline | Candidate | Tempo médio baseline → candidate | Tokens médios baseline → candidate |
|---|---:|---:|---:|---:|
| Codex, 11 positivos | 11/11 | 11/11 | 7.381 → 6.645 ms | 9.380,18 → 9.377,64 |
| Codex, 11 negativos | 11/11 | 11/11 | 7.035 → 6.563 ms | 9.371,00 → 9.374,82 |
| Cursor, 11 positivos | 11/11 | 11/11 | 11.836 → 11.916 ms | não reportado |
| Cursor, 11 negativos | 11/11 | 11/11 | 13.225 → 13.379 ms | não reportado |

O resultado demonstra ausência de regressão nesse corpus. Uma repetição por
braço não basta para atribuir causalidade às diferenças pequenas de latência ou
tokens; por isso elas são reportadas, mas não usadas como alegação de ganho.

O [benchmark comportamental](2026-09-06-agent-skills-behavior-benchmark.md)
executou duas repetições de `execute-regression` com o Codex:

| Braço | Success rate | Tempo médio ± desvio | Tokens médios ± desvio | Tool calls médios |
|---|---:|---:|---:|---:|
| Sem Skill | 2/2 | 57.142 ± 5.325 ms | 20.024,5 ± 8.874,9 | 6 |
| Baseline | 2/2 | 70.228 ± 1.440 ms | 23.965,0 ± 4.415,2 | 8 |
| Candidate | 2/2 | 68.127,5 ± 415 ms | 35.637,5 ± 7.037,8 | 9 |

O candidate preservou sucesso e foi 3,0% mais rápido que o baseline nessa
amostra, mas consumiu 48,7% mais tokens não-cacheados e uma tool call adicional.
O corpo enviado era menor e não houve mudança no workflow de execução; a
variação de trajetória do modelo dominou os poucos tokens estáticos removidos.
Portanto esta execução comprova a redução de contexto estático, mas **não** uma
redução de tokens end-to-end. O resultado negativo foi mantido como evidência,
sem ajustar a rubrica ou selecionar apenas a rodada favorável. O braço sem Skill
também passou este fixture estreito e foi mais barato; isso mostra que um único
bug mecânico não mede o valor das garantias de branch, evidência e recovery da
Skill, que exigem o restante do corpus comportamental.

Resultados live e suas limitações são registrados nos arquivos de evidência ao
lado deste relatório. Claude 2.1.261 atingiu o limite de sessão no smoke test;
isso é `HARNESS_ERROR`, não regressão de Skill. Codex 0.153.4 passou o smoke
baseline e candidate de `resolve-issue`; Cursor 2026.08.31 passou depois que o
harness recebeu trust somente para o fixture descartável com sandbox habilitado.

## Arquivos alterados

- Onze `skills-src/*/SKILL.md.in`, contracts/workflows compartilhados, manifest e
  os 163 recursos gerados em `skills/` e `packages/issue-flow/prompts/`.
- `packages/issue-flow/src/storage/{artifact-paths,artifact-storage,project-identity}.ts`,
  o resolver e a integração de banco/projeções para o store global ou local único.
- `packages/issue-flow/scripts/skill-entries/artifacts.entry.mjs`, distribuído
  como `scripts/artifacts.mjs` em cada Skill.
- `packages/issue-flow/src/core/{document-result,plan-result}.ts` e os comandos
  `analyze`, `prd` e `plan`, que agora validam e persistem resultados do modelo.
- Templates em `packages/issue-flow/prompts-src/`, incluindo contexto comum e
  blocos condicionais de execute/PR review; respectivos outputs gerados.
- `evals/skills/scenarios.json`.
- `packages/issue-flow/scripts/skills-eval.mjs` e o smoke de providers.
- `packages/issue-flow/scripts/skills-benchmark.mjs` (novo).
- `packages/issue-flow/scripts/skills.test.mjs`.
- `packages/issue-flow/package.json`.
- `docs/storage.md`, `skills/README.md`, `docs/cli.md`, `docs/issues.md`,
  `docs/skills.md`, `docs/skills-evals.md`, `docs/configuration.md`,
  `docs/commands.md`, `docs/code-organization.md`, `docs/project-status.md` e os
  índices/AGENTS aplicáveis.
- Este relatório e evidências JSON/Markdown de benchmark.

## Validação

Executado até a publicação deste relatório:

- `skills:sync`: 163 recursos gerados;
- `skills:check`: onze Skills autocontidas e byte parity;
- `skills:eval -- --check`: 102 cenários válidos;
- `skills:test`: 44/44 testes;
- lint Biome completo: passou em 438 arquivos;
- lint e typecheck completos: passaram;
- build da CLI: passou;
- suíte unitária: 177 arquivos, 2.266/2.266 testes; executada fora do sandbox
  para permitir os sockets do monitor;
- integração: 13/13 testes executados e um teste live opcional ignorado; a
  execução fora do sandbox confirmou processos e sockets reais;
- instalação: descoberta e instalação das onze Skills passaram nos modos copy e
  symlink para Claude/Codex/OpenCode; refresh local/Git passou nos casos aplicáveis;
- smoke de providers e packed CLI: 53/53 checks, incluindo os protocolos
  estruturados e a persistência determinística dos artifacts;
- smoke live: Codex passou baseline/candidate; Cursor passou candidate; Claude
  ficou indisponível por quota.
- triggering live: 88/88, Codex e Cursor, baseline/candidate holdout.
- behavior live: 6/6 no fixture corrigido; qualidade estável, token saving de
  runtime não comprovado.

Uma regressão do próprio eval foi encontrada: `execute-regression` declarava uma
branch no plano, mas criava o fixture em `main`. A Skill recusou corretamente o
checkout inconsistente quando o sandbox protegeu `.git`. O fixture agora começa
na branch declarada; os braços foram descartados e repetidos sobre o mesmo estado.

Durante a validação do novo helper, o primeiro bundle importava indiretamente o
runtime completo da CLI. O teste de isolamento detectou a dependência; identidade,
layout e seleção do store foram extraídos para módulos puros, e o bundle voltou a
funcionar sem CLI. O smoke empacotado também expôs fixtures do protocolo antigo
que escreviam documentos diretamente; elas passaram a emitir os mesmos blocos
estruturados exigidos dos agentes e agora testam a persistência da CLI.

Os benchmarks live não certificam native activation: seleção usa catálogo de
name/description e behavior carrega explicitamente o artifact isolado. Tokens
de Cursor permanecem `null` porque o harness não os informa. Números estáticos
são proxy de caracteres, não billing. Evals pagos continuam on demand para não
tornar credenciais e custo requisitos de CI.
