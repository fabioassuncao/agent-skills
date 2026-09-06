# Quatro repositórios de "graph": o que dá para absorver

**Data da análise:** 2026-09-06 · **Issue Flow:** `0.20.0`, branch `develop`
**Convenção:** cada afirmação é **FATO** (verificado no código clonado, com caminho),
**INFERÊNCIA** (dedução a partir de fatos) ou **RECOMENDAÇÃO**.
**Relacionado:** `#116` (Loop/Graph/Harness Engineering), `#119` (colaboração multiagente),
`#124` (absorção do Webmux), `#125` (absorção de `graph` e `graph-engineering`).

---

## 0. Executive summary

Os quatro projetos foram clonados e lidos. **Nenhum dos quatro é, ao mesmo tempo,
maduro, licenciado de forma segura e alinhado ao problema do Issue Flow** — mas três
deles contêm peças pequenas e valiosas, e uma delas é a melhor referência de design que
encontrei até agora para o runtime que `#116` quer especificar.

| Projeto | O que é de fato | Licença | Veredito |
|---|---|---|---|
| **Awesome-Graph-Engineering** | *Survey* acadêmico (arXiv 2608.21156) + lista curada. Zero código. | MIT | **Inspirar** — bibliografia para `#116`; não cobre grafo de código |
| **RepoGraph** | Grafo de código repo-level para SWE-bench. 735 LOC de núcleo, abandonado. | Apache-2.0 | **Inspirar** (conceito) + **Descartar** (código) |
| **agent-graph** | Plataforma visual multiagente (FastAPI+Mongo+MinIO), 40k LOC. Não é grafo de código. | Apache-2.0 | **Inspirar** — 3 padrões valem; o código não |
| **GraphCode** | App macOS que orquestra grafos de **sessões vivas** de coding agents. 85k LOC Swift. | **Dupla: MIT + FSL-1.1-MIT** | **Adaptar/Extrair** (parte MIT) — a mina de ouro |

**A descoberta central:** apenas o RepoGraph trata de *grafo de código*. Os outros três
tratam de *grafo de execução de agentes* — que é o problema real do Issue Flow. E o
GraphCode, que ninguém classificaria como "projeto de grafo de código", é o que tem as
abstrações mais diretamente aplicáveis ao que `#116` está tentando decidir.

**Alerta de licença que decide escopo (FATO):** o GraphCode é **duplamente licenciado**
(`LICENSE:1-15`). `GraphcodeKit/` e `graphcode-cli/` são MIT; **todo o resto — o app e o
daemon `graphcoded` — é FSL-1.1-MIT**, que proíbe *Competing Use*: "tornar o Software
disponível a terceiros num produto ou serviço comercial que substitua o Software ou
ofereça funcionalidade igual ou substancialmente similar". O Issue Flow é um orquestrador
de agentes de codificação — **está exatamente nessa categoria**. Ler para aprender é
permitido e conceitos não são copyrightáveis; copiar código FSL para dentro do Issue Flow
não é uma opção. A parte MIT é segura e, felizmente, é onde está quase tudo que interessa.

---

## 1. Awesome-Graph-Engineering (DEEP-JLU)

### 1.1 Objetivo e maturidade

**FATO.** 8 arquivos no total: `README.md` (688 linhas), `LICENSE` (MIT), 6 PNGs.
289 stars, 24 commits, 12 autores, criado 2026-08-20, último push 2026-09-05.
É o repositório-companheiro do survey *Graph Engineering in the Era of LLM Agents: From
Individual Intelligence to System Intelligence* ([arXiv 2608.21156](https://arxiv.org/abs/2608.21156)).

**FATO.** A taxonomia do survey tem três camadas:

- **Model Intelligence** — pré-treino, pós-treino, prompt engineering, context engineering;
- **Individual Intelligence** — tool integration, memory, skill composition, *runtime
  orchestration*, *loop architecture*, interaction paradigm, environment feedback;
- **System Intelligence** — *task organization*, *agent coordination*, *state management*,
  system evolution, ontology engineering.

**FATO — o que o survey NÃO cobre.** Não há uma única entrada sobre grafo de código,
grafo de repositório, AST, tree-sitter ou análise estática. `grep -i "repograph\|code
graph\|repo-level"` no README retorna zero. A seção *Software Engineering* lista
ferramentas (SWE-agent, OpenHands, Claude Code, Codex, Cline), não técnicas de indexação.

**INFERÊNCIA.** "Graph Engineering" nesse survey significa **grafo de tarefas/agentes/
estado**, não grafo de código. Isso confirma a hipótese de `#116` de que o termo é
ambíguo no mercado, e dá uma resposta objetiva: a literatura acadêmica usa o termo para
o que o Issue Flow já faz (coordenar unidades de trabalho), não para indexar repositórios.

### 1.2 O que aproveitar

**RECOMENDAÇÃO — usar como bibliografia de `#116`, não como fonte de arquitetura.**
As entradas de maior valor para as decisões abertas do Issue Flow:

| Decisão aberta em `#116`/`#124` | Referência do survey |
|---|---|
| Grafo coordena ou substitui loops? | *LLMCompiler* (ICML 2024, arXiv 2312.04511) — dispatch paralelo de nós independentes; *Plan-over-Graph* (arXiv 2502.14563) |
| Estagnação e loops infinitos (`detectNonConvergence` sem call site) | *When Agents Do Not Stop: Uncovering Infinite Agentic Loops* (arXiv 2607.01641) |
| Gate de aceitação por evidência (nosso `src/verify/`) | *Proof-or-Stop* (arXiv 2607.14890); *ResearchLoop* (arXiv 2605.28282) |
| `events.jsonl` + replay + retomada | *The Log is the Agent: Event-Sourced Reactive Graphs for Auditable, Forkable Agentic Systems* (arXiv 2605.21997) |
| Análise de impacto de mudança | *TDAD: Test-Driven Agentic Development — Reducing Code Regressions via Graph-Based Impact Analysis* (arXiv 2603.17973) |
| Atribuição de falha em fila multi-issue | *MAST* (NeurIPS 2025); *Who & When* (arXiv 2505.00212) |
| Versionamento de estado multiagente | *AgentGit* (arXiv 2511.00628); *SagaLLM* (arXiv 2503.11951) |
| Harness como variável oculta em avaliação | *The Scaffold Effect* (arXiv 2607.22585); *Harness-Bench* (arXiv 2605.27922) |

**Classificação: Inspirar.** Nada a extrair — não há código. Valor: economizar semanas de
levantamento bibliográfico em `#116` e dar ao documento de decisão referências revisadas
em vez de posts opinativos.

---

## 2. RepoGraph (ozyyshr)

### 2.1 Objetivo e maturidade

**FATO.** Apache-2.0, 301 stars, 43 forks, 19 commits, 3 autores. Criado 2024-08-08,
**último push 2025-04-01** — 17 meses parado. 12 issues abertas, nenhuma respondida.
É o artefato de um paper: plug-in de contexto repo-level para SWE-bench, integrado a
Agentless e SWE-agent.

**FATO — o núcleo tem 735 linhas em 3 arquivos:**

| Arquivo | LOC | Responsabilidade |
|---|---|---|
| `repograph/construct_graph.py` | 591 | Extrai tags (def/ref) com tree-sitter e monta o grafo NetworkX |
| `repograph/utils.py` | 100 | `create_structure()` — varre o repo com `ast` e monta dicionário classes/funções/linhas |
| `repograph/graph_searcher.py` | 44 | `RepoSearcher`: 1-hop, 2-hop, DFS, BFS |

O resto (`agentless/`, `SWE-agent/`) é código de terceiros vendorizado com um flag
`--repo_graph` costurado dentro.

### 2.2 Como o grafo é construído (o que realmente acontece no código)

**FATO — pipeline.** `CodeGraph.__init__` chama `create_structure(root)`; `get_tags_raw`
roda uma query tree-sitter por arquivo; `tag_to_graph` monta um `nx.MultiDiGraph`.

**FATO — a query tree-sitter é hard-coded e só de Python** (`construct_graph.py:238-251`).
Apesar de importar `filename_to_lang` do `grep-ast` (que suporta dezenas de linguagens), a
S-expression embutida no código só reconhece `class_definition`, `function_definition` e
`call`. E `find_files()` (`:551-561`) descarta explicitamente tudo que não termina em
`.py`. **O projeto é monolíngue por construção.**

**FATO — o modelo de grafo é raso.** O nó é o **nome do símbolo** (string), não uma
entidade com identidade de arquivo:

```python
G.add_node(tag['name'], category=..., info=..., fname=..., line=..., kind=...)
```

Duas funções homônimas em módulos diferentes colidem no mesmo nó. Não há nó de arquivo,
diretório, módulo ou import. As arestas são duas: `classe → método` e `ref → def` por
**igualdade de nome** (`:100-110`) — um `for` aninhado O(refs × defs) sem índice.

**FATO — não há PageRank.** É a diferença mais citada e é falsa: `get_ranked_tags()`
(`:398-449`) monta `personalization = dict()`, calcula `personalize = 10/len(fnames)`,
preenche o dicionário… e **nunca chama `nx.pagerank`**. `grep -rn "pagerank"` no diretório
`repograph/` retorna zero ocorrências. A herança do Aider RepoMap foi cortada: o que
sobrou coleta tags e devolve a lista sem ranquear.

**FATO — `exec()`/`eval()` sobre o código analisado** (`std_proj_funcs`, `:146-203`).
Para descobrir quais símbolos vêm de bibliotecas de terceiros, o código **executa as
declarações de import do repositório-alvo** e usa `inspect.getmembers(eval(nome))`.
Indexar um repositório desconhecido roda código desconhecido. É RCE por design, e é
também o motivo de a técnica ser intransportável para outra linguagem.

**FATO — remendos de string para o corpus do SWE-bench** (`:262-276`): o código substitui
`"False"`→`"_False"`, `"print "`→`"yield "`, `"Error, "`→`"Error as "` no fonte antes de
parsear, para fazer código Python 2 passar pelo parser. Isso corrompe o texto que depois
é entregue ao modelo como contexto.

**FATO — sem cache e sem atualização incremental.** `get_tags()` (`:205-212`) lê o mtime
do arquivo, tem um comentário `# miss!` e **sempre** reparseia. Não há persistência
incremental: o `__main__` serializa o grafo inteiro com `pickle.dump` e faz *append* das
tags num `.jsonl` — reexecutar duplica o arquivo de tags. A issue #10 aberta pede
justamente "Repograph cache". O README admite: "this version may take a little long time
to run for a repo" e distribui um dump pré-computado no Hugging Face.

**FATO — o entrypoint publicado está quebrado.** `tag_to_graph` acessa `tag['name']`, mas
`tags` é uma lista de `Tag` (namedtuple), que não aceita indexação por string. A issue #18
("Known Bugs and Fixes") documenta esse e outro bug com o patch; nunca foi mergeado.

### 2.3 Graph Engineering aplicado a agentes (a parte boa)

**FATO — duas integrações, ambas minúsculas e ambas instrutivas:**

1. **Ferramenta de agente** — `SWE-agent/sweagent/environment/retrieve_graph.py`, **35
   linhas**: dado um símbolo, devolve `G.successors(x) + [x] + G.predecessors(x)`,
   filtrando arquivos com `test` no caminho. Exposto ao modelo como uma ação nova no
   espaço de ações (`SWE-agent/config/default.yaml:8-12`):

   > `search_repo <search_term>` — *searches in the current repository with a specific
   > function or class, and returns the def and ref relations for the search term.*

   E instruído no prompt (`:63`): *"Before you proceed to edit, always look up for related
   context using `search_repo`"*.

2. **Injeção em pipeline procedural** — `agentless/fl/localize.py:52-98`
   (`construct_code_graph_context`) pega as localizações já encontradas, busca os *refs*
   de cada símbolo, recupera o corpo da função/método que contém aquela linha e monta um
   bloco `### Dependencies for {func}` que entra num prompt dedicado
   (`agentless/fl/FL.py:120-153`, `obtain_relevant_code_graph_prompt`).

**INFERÊNCIA — a ideia que vale, isolada do código:** o ganho não vem do grafo ser
sofisticado; vem de **existir uma ferramenta que responde "quem chama isto e quem isto
chama", e de o prompt mandar o agente usá-la antes de editar**. O grafo aqui é raso,
monolíngue e sem ranking — e mesmo assim melhorou os resultados no SWE-bench. O custo de
entrada da ideia é uma ferramenta de 35 linhas sobre um índice qualquer.

### 2.4 Classificação por componente

| Componente | Caminho | Classificação | Razão |
|---|---|---|---|
| Ferramenta `search_repo` (contrato + prompt) | `SWE-agent/config/default.yaml:8-12,63-65`; `retrieve_graph.py` | **Inspirar** | 35 linhas triviais de reimplementar; o valor é o contrato e a instrução |
| Injeção `### Dependencies for` | `agentless/fl/localize.py:52-98` + `FL.py:120-153` | **Inspirar** | Formato de projeção de contexto por símbolo; reimplementar |
| `RepoSearcher` (1-hop/2-hop/DFS/BFS) | `repograph/graph_searcher.py` | **Descartar** | 44 linhas sem índice; `graphology`/implementação própria em TS é melhor |
| `create_structure` / `parse_python_file` | `repograph/utils.py` | **Descartar** | Só Python, via `ast`; nosso alvo é TypeScript multi-linguagem |
| `get_tags_raw` (extração tree-sitter) | `construct_graph.py:205-395` | **Descartar** | Query hard-coded, remendos de string, `exec()` de import |
| `std_proj_funcs` | `construct_graph.py:146-203` | **Descartar** — e não repetir | Execução de código de terceiros durante indexação |
| `tag_to_graph` | `construct_graph.py:93-110` | **Descartar** | O(n²), nó por nome, quebrado como publicado |

**RECOMENDAÇÃO.** Não portar uma linha. Levar **o contrato da ferramenta** e **o formato
do bloco de dependências**. Se um grafo de código entrar no Issue Flow um dia, a base
correta é `tree-sitter` + as queries `tags.scm` oficiais de cada gramática (que o
RepoGraph tinha comentadas em `:239-241` e substituiu por uma string embutida), não este
código.

---

## 3. agent-graph (keta1930)

### 3.1 Objetivo e maturidade

**FATO.** Apache-2.0, 221 stars, 41 forks, **809 commits, 2 autores**, ativo (último push
2026-08-09). Versão `3.0.0`, "Development Status :: 4 - Beta". 745 arquivos: 230 `.py`
(40.550 LOC em `agent_graph/app/`), 125 `.tsx` de frontend, 138 `.md` de documentação.

**FATO — é uma plataforma, não uma biblioteca.** Stack obrigatória: FastAPI, MongoDB
(`motor`), MinIO, `fastmcp`, `apscheduler`, LangChain, OpenAI SDK, JWT, frontend Vite.
Docker Compose para subir Mongo+MinIO. Não há como usar o motor de grafo sem a plataforma.

**FATO — maturidade de engenharia baixa para o tamanho.** 5 arquivos de teste unitário
(`tests/unit/`) para 40k LOC; o único workflow de CI é `docs.yml` (deploy do MkDocs) —
**não há CI rodando testes**. `services/graph/graph_processor.py` tem `print()` de debug
em caminho de produção (`:236`, `:268`, `:272`, `:293`). Comentários e mensagens de erro
em chinês.

### 3.2 Arquitetura do grafo

**FATO — modelo** (`models/graph_schema.py`): `GraphConfig{name, nodes[], end_template}`,
`AgentNode{name, agent_name, model_name, system_prompt, user_prompt, mcp_servers,
system_tools, max_iterations, input_nodes[], output_nodes[], handoffs, is_subgraph,
subgraph_name, level, position}`. **Aresta não é entidade** — é lista de nomes nos dois
sentidos, com `input_nodes`/`output_nodes` redundantes entre si.

**FATO — execução por nível, e estritamente sequencial**
(`services/graph/graph_executor.py:131-171`). O executor pega `max_level`, itera
`current_level` de 0 até o máximo, e para cada nível faz `for node in nodes_to_execute:`
executando um de cada vez. **Não há `asyncio.gather`.** Ou seja: apesar de calcular
níveis topológicos (que é exatamente a estrutura que permitiria paralelismo), a
plataforma executa tudo em série. *O mesmo diagnóstico que `#116` faz do Issue Flow.*

**FATO — cálculo de nível** (`graph_processor.py:114-307`, ~190 linhas): relaxamento
iterativo com `deepcopy`, heurísticas de fallback em cascata e a decisão deliberada de
**ignorar as arestas de nós com `handoffs` ao calcular níveis**, para que ciclos não
travem a ordenação (`:145-152`). A ideia — separar arestas de sequenciamento das arestas
de decisão — é boa; a implementação é frágil.

**FATO — validação estrutural** (`graph_processor.py:439-...`): referências de
entrada/saída inexistentes, subgrafo inexistente, auto-referência, e
`detect_graph_cycles()` (`:401-436`) que faz DFS recursivo **entre grafos** (um subgrafo
que referencia um ancestral) devolvendo o caminho do ciclo.

**FATO — retomada por checkpoint** (`graph_executor.py:69-118`):
`check_execution_resumption_point()` devolve uma ação (`continue`, `handoffs_continue`,
`handoffs_wait`, `error`) e o executor retoma a partir do nível ou do nó de handoff.

**FATO — versionamento do grafo** (`models/graph_schema.py:126-160`): `CreateVersionRequest`
com `commit_message`, versões no MinIO com `version_id`, listagem e recuperação de config
por versão. Um "git para grafos" simples.

### 3.3 As três ideias que valem

**(A) Handoff como tool call — `services/graph/handoffs_manager.py` (114 linhas).**
**FATO.** Para um nó com `handoffs`, o sistema gera dinamicamente ferramentas OpenAI
`transfer_to_<nome_do_nó>` a partir de `output_nodes` (`:14-58`), com a descrição do nó
destino como descrição da ferramenta. Depois, `extract_handoffs_selection()` (`:96-114`)
lê a tool call e extrai o destino.

**Por que é interessante:** a aresta condicional é expressa no **canal de tool call**, não
em prosa que precisa ser parseada. O modelo não "diz para onde ir" num texto livre — ele
chama uma função cujo nome é o destino, e destinos inválidos são impossíveis porque só as
arestas reais viram ferramentas. É a versão mais barata e mais robusta de roteamento
condicional que vi nos quatro projetos. Dependências: nenhuma além de suportar tool calls.

**(B) Projeção de contexto por placeholder — `utils/output_tools.py` (247 linhas) +
`services/system_tools/graph_designer/graph_design_spec_en.md:104-125`.**
**FATO.** Nos prompts de qualquer nó é possível referenciar saídas de outros nós:

| Sintaxe | Significado |
|---|---|
| `{{node}}` | última saída daquele nó |
| `{{node:3}}` | as 3 saídas mais recentes |
| `{{node:all}}` | histórico completo daquele nó |
| `{{@template}}` | template de prompt registrado |
| `{{a:2\|b:3}}` | referência conjunta a vários nós |

**Por que é interessante:** é *context engineering por nó* de forma **declarativa e
auditável** — o autor do grafo diz exatamente o que cada nó recebe, em vez de o runtime
empurrar o histórico inteiro. `#116` pergunta como "transportar evidência entre nós sem
carregar todo o contexto"; isto é uma resposta concreta e implementável em ~150 linhas de
TypeScript. Dependências: só regex.

**(C) Ferramentas de sistema como registry bilíngue —
`services/system_tools/registry.py` + cada `TOOL_SCHEMA` com chaves `zh`/`en`.**
**FATO.** Cada ferramenta declara schema OpenAI em dois idiomas e o registry escolhe pelo
idioma do usuário (`get_current_language()`). Valor baixo, mas é um padrão limpo para um
projeto que escreve issues em pt-BR e documentação em inglês.

### 3.4 Classificação por componente

| Componente | Caminho | Classificação |
|---|---|---|
| Handoff via `transfer_to_*` | `services/graph/handoffs_manager.py` | **Inspirar** (padrão) — reimplementar em ~80 linhas |
| Placeholders `{{node:N}}` | `utils/output_tools.py`, `graph_design_spec_en.md:104-125` | **Inspirar** — reimplementar em TS |
| Separar arestas de decisão do cálculo de nível | `graph_processor.py:145-152` | **Inspirar** (a ideia, não o código) |
| `detect_graph_cycles` entre grafos | `graph_processor.py:401-436` | **Inspirar** — já temos equivalente em `execution/order.ts` |
| Versionamento de grafo com commit message | `models/graph_schema.py:126-160` | **Descartar** — `tasks.json` em Git já resolve |
| Motor de execução, memória, MCP, frontend | `services/`, `frontend/` | **Descartar** — acoplado a Mongo/MinIO/FastAPI |
| `_calculate_node_levels` | `graph_processor.py:114-307` | **Descartar** — 190 linhas heurísticas com `print()`; ordenação topológica limpa é melhor |

---

## 4. GraphCode (scgopi) — a mina de ouro, com cerca

### 4.1 Objetivo e maturidade

**FATO.** App macOS (15+, Apple Silicon) que roda **grafos de sessões vivas de coding
agents**. Cada nó é uma unidade de trabalho dentro de uma sessão real de CLI (Claude Code,
Codex, Copilot CLI); cada aresta é handoff, mensagem ou spawn. Sessões sobrevivem ao
fechamento do app via [`zmx`](https://zmx.sh); terminal renderizado por GhosttyKit.

**FATO — maturidade alta.** 1.005 commits, 5 autores, criado 2026-07-25, push 2026-09-05,
versão 0.1.63 (build 250). 473 arquivos, **409 Swift (~85k LOC)**, **154 arquivos de
teste**, CI, releases assinados e notarizados, `CONTRIBUTING.md` + DCO, 16 issues abertas
com discussão técnica real. É o único dos quatro com qualidade de produto.

**FATO — licença dupla (`LICENSE:1-15`):**

| Diretório | Licença | LOC |
|---|---|---|
| `GraphcodeKit/` | **MIT** | 24.093 (101 arquivos) |
| `graphcode-cli/` | **MIT** | 607 |
| `graphcoded/`, `graphcode/`, `MailroomKit/` | **FSL-1.1-MIT** | ~61.500 |

A justificativa está no próprio arquivo: *"The integration surfaces stay MIT on purpose:
an agent writing `graphcode node create` into a script, or another tool linking the domain
types, should never have to read a license first."* — **o autor colocou de propósito em
MIT exatamente as partes que outro projeto iria querer reutilizar.**

**FATO — a FSL converte para MIT após 2 anos** ("MIT Future License"), mas até lá a
cláusula *Competing Use* vale, e o Issue Flow cai nela.

**FATO — armadilha de dependência.** `Domain/LoopNode.swift` e `Domain/LoopGraph.swift`,
embora dentro de `GraphcodeKit/` (MIT), fazem `import MailroomKit` — que **não tem LICENSE
própria** e portanto cai em "everything else" = FSL. O mesmo vale para `GraphStore.swift`
e `CLI/GraphcodeCommand.swift`. Já os tipos pequenos que recomendo abaixo
(`CycleGuard`, `EdgeCondition`, `EdgeKind`, `GoalSpec`, `ShellPredicate`, `LoopState`,
`PayloadTransform`, `AttentionRollup`, `UsageSample`, `ModelTier`, `WorktreeHygiene`,
`WorktreeRef`) **não importam nada além de `Foundation`** — verificado arquivo a arquivo.
São MIT limpos.

### 4.2 Arquitetura

**FATO — três processos.** `graphcode.app` (UI, FSL) · `graphcoded` (daemon launchd, dono
do grafo de cada projeto, dispara arestas, faz polling de predicados de goal, mantém
sessões vivas — FSL) · `graphcode` (CLI que fala com o daemon por socket unix — MIT).
Estado em `~/.graphcode/`; **nada é escrito dentro da pasta do projeto**.

**FATO — o daemon não agenda nada.** A recorrência de um loop temporal vive *dentro* da
sessão, escrita no prompt com a skill `/loop` do próprio agente. O daemon só mantém a
sessão viva. Isso é o que torna um loop em execução algo a que se pode anexar e corrigir,
em vez de um job que já terminou em algum lugar.

### 4.3 O modelo de domínio (o que realmente interessa)

**FATO — `Domain/CycleGuard.swift` (71 linhas, sem imports).** O guarda de um ciclo:

```swift
maxIterations: Int?                        // quantas vezes a aresta pode disparar
until: String?                             // shell reavaliado antes de cada redisparo; sai 0 → para
stopAfterPassesWithoutImprovement: Int?    // platô: N passes sem melhora na métrica
var isBounded: Bool                        // exige pelo menos um dos três
func allowsFiring(afterFireCount:) -> Bool
```

O comentário explica a decisão de design mais elegante que encontrei nos quatro projetos:

> **"A guard is also the switch that makes a cycle run at all."** Sem guarda, a aresta
> dispara exatamente uma vez e um ciclo desenhado fica inerte. Anexar um guarda é o que
> habilita o redisparo — e só se pode fazê-lo com um limite junto. *"There is no way to
> express 'loop forever' by accident, because the feature that lets a loop repeat is the
> same feature that bounds it."*

**FATO — `Domain/LoopState.swift` (9 estados, sem imports):** `idle → running →
{awaitingInput, blocked, waiting} → running → {succeeded, failed, stalled}`, mais
`stopped`. Dois merecem destaque: **`waiting`** ("o nó fez a sua parte e está parado até
os dependentes resolverem" — distinto de `idle` e de `blocked`) e **`stopped`** ("um
humano parou; o trabalho não deu errado, alguém decidiu que não deveria continuar —
juntar os dois encheria a fila de 'Failed' com paradas deliberadas").

**FATO — `Domain/GoalSpec.swift` (185 linhas):** `summary` (o "done" em palavras humanas,
**obrigatório**), `predicate` (comando shell, **opcional** — *"plenty of real goals have
no honest shell equivalent, and inventing one would be worse than admitting it"*),
`pollIntervalSeconds` (default 60), `stallAfterSeconds`, `metricCommand` +
`metricDirection` (número na última linha do stdout, amostrado **uma vez por passe**, não
a cada poll), `tokenBudget`, `skipsUnchangedWorkspace` (não repolla enquanto o HEAD e os
arquivos sujos não mudarem). E `sessionPrompt()`: **o nó recebe no prompt o mesmo
predicado, a mesma métrica e o mesmo orçamento que o orquestrador vigia**, para que os
dois não trabalhem com definições diferentes de "pronto" e de "melhor".

**FATO — `Domain/EdgeKind.swift` / `EdgeCondition.swift` / `PayloadTransform.swift`:**
três tipos de aresta (`handoff` bloqueia o alvo, `message` injeta em par vivo, `spawn`
instancia), três condições (`always`/`onSuccess`/`onFailure` com
`isSatisfied(sourceSucceeded:)` no próprio tipo, *"para que o editor de arestas explique a
mesma regra que o runtime aplica"*), e três transformações de payload (`none`,
`template(String)`, **`script(String)`** — *"quando a transformação é mecânica, a aresta
deve poder rodar um comando em vez de pagar um modelo para rederivar os mesmos passos"*).

**FATO — `Sessions/ShellPredicateEvaluator.swift`.** Um único avaliador serve três
consumidores (stop condition de goal, `until` de ciclo, payload `.script`). Detalhes que
valem cópia conceitual:

- o comando vai **por variável de ambiente** (`GRAPHCODE_PREDICATE`), não interpolado na
  string — *"so a predicate containing quotes or `;` can't break out of it"*;
- **"não conseguiu rodar" ≠ "passou"**: retorna `false`/`nil`, nunca sucesso —
  *"resolving a goal on a broken predicate would act on work nobody verified"*;
- guarda o **tail da saída** (600 chars, stdout+stderr juntos) porque *"um predicado que
  falha tem mais um trabalho: dizer à sessão por que ainda não está pronto"*;
- usa **pipe, não PTY**, com um comentário de 10 linhas explicando que sob daemon de QoS
  baixa o buffer do PTY perdia a saída pós-exit e **toda métrica registrava "not
  measured"** — bug que nenhum teste unitário pegava porque em processo de foreground a
  corrida era ganha.

**FATO — `Domain/UsageSample.swift`:** todos os campos são opcionais *e isso é a parte
honesta*. Tokens são **reportados** pelos hooks do backend, nunca estimados. *"The
alternative — estimating tokens from scrollback length, or displaying a plausible-looking
zero — would make a cost panel that lies, which is worse than one that admits it doesn't
know."* O Issue Flow já tem essa regra (`docs/conventions.md`, `src/telemetry/AGENTS.md`);
aqui ela está codificada no tipo.

**FATO — `Domain/ModelTier.swift`:** tiers nomeados por **papel** (`fast`/`standard`/
`capable`), não por modelo — *"which model is currently cheapest is not stable, and baking
a specific one into every persisted node would make graph files go stale every time the
model lineup changes"*. `standard` **não emite `--model` nenhum**, deixando valer o
default configurado na CLI do usuário; e o roteamento automático é **opt-in**, porque
sobrescrever silenciosamente o modelo que a pessoa configurou foi tratado como bug
(issue #10 do projeto).

**FATO — `Domain/AttentionRollup.swift`:** por que um loop pede humano, ordenado
pior-primeiro (`failed > stalled > awaitingInput > blocked`), com duas leituras da mesma
fila: *worst-first* para **ler**, *oldest-first* para **trabalhar* — *"repeat presses
can't keep landing on the same loop"*.

**FATO — `Domain/WorktreeHygiene.swift` (271 linhas):** classificador **puro** de
worktrees em três tiers — `safeToRemove` (landed, limpo, pushado, sem loop ligado),
`lookBeforeRemoving`, `inUse` (loop rodando). Lê `commitsNotLanded`, `squashLanded`
(*"`git cherry` sozinho responde errado para um PR squash-merged de mais de um commit"*),
`dirtyFileCount` **incluindo untracked** (*"é onde vive um experimento pela metade"*),
`pushed` (sem upstream = não pushado, não seguro), `prunable`, `locked`, `hasSubmodules`.
*"O classificador é puro para que a lógica de tier — a parte que precisa estar certa —
seja testável sem repositório."*

**FATO — decodificação tolerante a versões.** `LoopEdge` e `GoalSpec` escrevem
`init(from decoder:)` à mão para que **um campo adicionado depois do último save decodifique
com seu default em vez de falhar o grafo inteiro** — porque uma falha de decode viraria
"seu projeto foi apagado" para o usuário. `LoopEdge` ainda lê chaves legadas
(`payloadNote`, `fired`) sem nunca reescrevê-las: *"ler a forma antiga é migração;
escrevê-la seria manter duas fontes de verdade"*.

**FATO — códigos de saída da CLI** (`graphcode-cli/Sources/main.swift:13-24`): `1` uso
incorreto, **`69` (EX_UNAVAILABLE)** daemon inalcançável, nada foi escrito, *retry é
seguro*, **`75` (EX_TEMPFAIL)** o comando saiu mas a resposta não voltou — *pode ter sido
aplicado; `node create`, `node send` e `node memo` não são idempotentes, então um wrapper
não deve repetir cegamente*.

**FATO — `GraphStore.sessionPermitsResolution`** (`:2038-2077`): uma resolução reportada
pela superfície só é aceita se a sessão realmente morreu. Três defesas: janela de graça
após restart (*"o kill do próprio restart"*), em projeto remoto exige `.absent`
confirmado (*"a saída do painel é uma alegação transmitida pelo mesmo link cuja falha
está sendo tratada"*), e localmente pergunta se a sessão ainda vive (*"fechar o painel
com ⌘W marcava o loop como falho enquanto a sessão seguia headless"*). Cada recusa é
gravada na memória do nó.

**FATO — Mailroom.** Quadro de recados compartilhado do grafo (`mail post/inbox/read/
list/watch`, com tópicos, cursor de não-lidos e headlines quando o backlog é grande).
Fica **dentro do `LoopGraph`**, e não num store paralelo, para herdar de graça um único
escritor, persistência atômica junto do grafo e snapshot em todo `.graphChanged`.
*(FSL via MailroomKit — conceito apenas.)*

**FATO — `Sessions/MermaidBoardParser.swift` + `Domain/SummaryBoard.swift`:** a sessão
resume o que fez como Mermaid; o app parseia um **subconjunto declarado** (flowchart +
tabela GFM) e desenha nativo; o que não entende vira código, sem falhar. E `BoardForm`
tem **duas** opções (`flow`, `table`) de propósito: *"um modelo com um menu de dez tipos
de diagrama vai achar razão para usar todos, e um run desenhado como diagrama de
sequência porque o menu tinha um é uma figura que fala sobre o menu"*.

### 4.4 Classificação por componente

| Componente | Caminho (todos MIT, sem imports externos) | Classificação |
|---|---|---|
| `CycleGuard` | `GraphcodeKit/Sources/Domain/CycleGuard.swift` | **Absorver** (portar 1:1 para TS) |
| `EdgeCondition` + `EdgeKind` | `Domain/EdgeCondition.swift`, `EdgeKind.swift` | **Absorver** |
| `LoopState` (9 estados) | `Domain/LoopState.swift` | **Adaptar** — mapear para nossa story/queue |
| `GoalSpec` (+ métrica, budget, platô) | `Domain/GoalSpec.swift` | **Adaptar** — casa com `src/verify/` |
| `ShellPredicate` + `PredicateOutcome` | `Domain/ShellPredicate.swift` | **Absorver** |
| `ShellPredicateEvaluator` | `Sessions/ShellPredicateEvaluator.swift` | **Adaptar** — reimplementar em Node com as mesmas 4 regras |
| `WorktreeHygiene` (classificador puro) | `Domain/WorktreeHygiene.swift` | **Adaptar** — melhor peça isolada do repo |
| `AttentionRollup` | `Domain/AttentionRollup.swift` | **Adaptar** — alimenta o monitor web |
| `UsageSample` (honestidade) | `Domain/UsageSample.swift` | **Inspirar** — regra já é nossa, falta o tipo |
| `ModelTier` (papel, não modelo; opt-in) | `Domain/ModelTier.swift` | **Adaptar** — `src/routing/` |
| `PayloadTransform` (`.script`) | `Domain/PayloadTransform.swift` | **Absorver** |
| Decode tolerante a versão | `Domain/LoopEdge.swift:88-160`, `GoalSpec.swift:170-185` | **Inspirar** — nossa regra "preservar campos desconhecidos" |
| Exit codes 69/75 | `graphcode-cli/Sources/main.swift:13-24` | **Absorver** — `docs/commands.md` |
| `sessionPermitsResolution` | `GraphStore.swift:2038-2077` (MIT, mas o arquivo importa MailroomKit) | **Inspirar** — só o raciocínio |
| Mailroom | `MailroomKit/` | **Inspirar** — **FSL**, conceito apenas |
| `MermaidBoardParser`/`SummaryBoard` | `Sessions/`, `Domain/` | **Inspirar** — subconjunto declarado + duas formas |
| App, daemon, UI, zmx/Ghostty | `graphcode/`, `graphcoded/`, `ThirdParty/` | **Descartar** — FSL e/ou macOS-only |

---

## 5. Comparação

Escala: ●●● forte · ●● parcial · ● fraco · — ausente.

| Dimensão | Awesome-GE | RepoGraph | agent-graph | GraphCode |
|---|:--:|:--:|:--:|:--:|
| Construção de grafo (código) | — | ●● | — | — |
| Construção de grafo (execução) | ● (teoria) | — | ●● | ●●● |
| Parsing de código | — | ●● (só Python) | — | ● (Mermaid) |
| Representação de relações | — | ● (nó = string) | ● (aresta implícita) | ●●● (aresta é entidade) |
| Armazenamento | — | ● (pickle) | ●● (Mongo/MinIO) | ●● (JSON atômico + decode tolerante) |
| Atualização incremental | — | — | ● | ●● (fireCount, checkpoints) |
| Consulta | — | ●● (1/2-hop, DFS/BFS) | ● | ●● (ready/blocked/anchors) |
| Ranking de contexto | — | — (PageRank removido) | ●● (placeholders) | ● |
| Integração com LLM | ● | ●● (prompt de dependências) | ●●● (handoff via tool call) | ●●● (prompt = contrato do nó) |
| Integração com agentes | — | ●● (`search_repo`) | ●● (MCP, subagentes) | ●●● (CLI + sessões vivas) |
| Planejamento de tarefas | ● | — | ●● (graph designer) | ●● (composite + pilot/arm) |
| Descoberta de contexto | — | ●●● | ●● | ● |
| Análise de impacto | ● (TDAD) | ●● (refs 1-hop) | — | ●● (worktree landing) |
| Escalabilidade | — | ● | ●● | ●● (macOS/local) |
| Extensibilidade | — | ● | ●● | ●●● |
| Qualidade de código | n/a | ● | ●● | ●●● |
| Maturidade | ●● | ● (parado 17m) | ●● | ●●● |
| **Potencial de reúso** | **●● (biblio)** | **●● (2 ideias)** | **●● (3 ideias)** | **●●● (12 tipos MIT)** |

### A combinação que eu proporia

- **Conceito e vocabulário** → Awesome-Graph-Engineering (taxonomia) + `#116`;
- **Modelo de grafo de execução** → **GraphCode** (aresta com guard/condição/transformação,
  `CycleGuard`, `LoopState`);
- **Roteamento condicional** → **agent-graph** (handoff como tool call);
- **Projeção de contexto por nó** → **agent-graph** (placeholders) + **RepoGraph**
  (bloco `### Dependencies for`);
- **Gate determinístico e métrica** → **GraphCode** (`GoalSpec` + `ShellPredicateEvaluator`),
  ligado ao nosso `src/verify/` que já existe;
- **Isolamento e higiene de worktree** → **GraphCode** (`WorktreeHygiene`);
- **Tudo o mais** → implementação própria em TypeScript.

---

## 6. Riscos

**Licenciamento**

| Risco | Severidade | Mitigação |
|---|---|---|
| Copiar código FSL do GraphCode (app/daemon/MailroomKit) | **Alta** — Issue Flow é *Competing Use* | Restringir porte a `GraphcodeKit/Domain/*` e `graphcode-cli/`; nunca ao `graphcode/`, `graphcoded/`, `MailroomKit/` |
| `LoopNode`/`LoopGraph`/`GraphStore` são MIT mas importam MailroomKit (FSL) | Média | Portar apenas os tipos sem imports; verificado: os 12 recomendados só usam `Foundation` |
| Atribuição MIT (GraphCode) e Apache-2.0 (RepoGraph, agent-graph) | Baixa | Cabeçalho de atribuição por arquivo portado + `NOTICE` para Apache-2.0 |
| RepoGraph Apache-2.0 é derivado do Aider (Apache-2.0) e grep-ast | Baixa | Cadeia compatível; se portar, citar as três origens como o próprio arquivo faz (`construct_graph.py:1-4`) |

**Técnicos**

- **Cache/índice desatualizado** (RepoGraph não tem invalidação): um contexto obsoleto
  entregue como fresco é pior que nenhum contexto. Se um grafo de código entrar, a
  invalidação precisa nascer junto.
- **Execução de código de terceiros na indexação** (`std_proj_funcs`): não repetir, em
  nenhuma forma.
- **Nível topológico sem paralelismo real** (agent-graph): calcular níveis não é
  paralelizar; sem isolamento, paralelizar é regressão — restrição já registrada em `#116`.
- **Dependência de runtime Python** (RepoGraph, `graph`, `graph-engineering` de `#125`):
  o Issue Flow é Node/TS; qualquer sidecar Python precisa de justificativa explícita.
- **Projetos parados**: RepoGraph sem push há 17 meses; agent-graph com 2 mantenedores e
  sem CI de teste. Absorver deles = herdar manutenção.

---

## 7. O que eu incorporaria agora

Sete itens, ordenados por (benefício ÷ complexidade). Nenhum exige um "motor de grafo"
novo: todos plugam em primitivas que já existem no Issue Flow.

### 7.1 `CycleGuard` — limite que habilita o ciclo

- **Origem:** GraphCode · `GraphcodeKit/Sources/Domain/CycleGuard.swift` (71 linhas, MIT, sem imports)
- **Conceito:** anexar um guarda é o que **permite** re-executar; e só se pode anexá-lo com
  um limite (`maxIterations`, `until`, ou N passes sem melhora). Loop infinito por acidente
  vira inexprimível.
- **Reaproveitamento:** **Absorver** (porte 1:1, ~80 linhas de TS + testes)
- **Mudanças:** novo tipo em `src/core/`; ligar em `maxCorrectionCycles` (hoje do plano
  inteiro) e ao `detectNonConvergence()`/`nextRung()` de `src/routing/escalation.ts` —
  que hoje **existem, são puros, são testados e não têm nenhum call site em produção**.
  `stopAfterPassesWithoutImprovement` é literalmente o platô que aquelas funções detectam.
- **Benefício:** fecha a lacuna mais concreta apontada em `#116` com código que já temos;
  orçamento por nó em vez de por plano.
- **Complexidade:** Baixa · **Riscos:** exige uma métrica por story para o platô funcionar;
  sem métrica, cair para `maxIterations`.

### 7.2 `ShellPredicate` + avaliador único

- **Origem:** GraphCode · `Domain/ShellPredicate.swift`, `Sessions/ShellPredicateEvaluator.swift` (MIT)
- **Conceito:** um único avaliador de comando shell serve stop condition, guarda `until` e
  transformação de payload. Quatro regras: comando por **variável de ambiente** (nunca
  interpolado); **não-executável ≠ passou**; guardar o **tail** de stdout+stderr para
  devolver ao agente o *porquê*; **pipe, não PTY**.
- **Reaproveitamento:** **Adaptar** (reimplementar em Node, ~120 linhas)
- **Mudanças:** `src/utils/` ao lado de `shell.ts`; consumir de `src/verify/runner.ts`.
- **Benefício:** o "não conseguiu rodar = `unverified`" já é a nossa regra; aqui vira uma
  função só, com o output de falha realimentando a correção.
- **Complexidade:** Baixa · **Riscos:** nossa allow-list de comandos precisa cobrir o caso.

### 7.3 Handoff como tool call

- **Origem:** agent-graph · `services/graph/handoffs_manager.py` (114 linhas, Apache-2.0)
- **Conceito:** gerar dinamicamente ferramentas `transfer_to_<destino>` a partir das
  arestas de saída reais e ler a decisão do canal de tool call, nunca da prosa.
- **Reaproveitamento:** **Inspirar** (reimplementar, ~80 linhas)
- **Mudanças:** aplicável às transições de fase (`core/workflow-contract.ts`) e à escolha
  de próxima story; exige que o agente exponha tool calls — verificar por
  `AgentCapabilities` (`src/agents/`) e cair para o formato textual atual quando não houver.
- **Benefício:** destino inválido deixa de ser possível; some o parsing de intenção em texto.
- **Complexidade:** Média · **Riscos:** capacidade desigual entre Claude/Codex/Cursor/Antigravity.

### 7.4 Projeção de contexto por nó via placeholders

- **Origem:** agent-graph · `utils/output_tools.py` + `graph_design_spec_en.md:104-125` (Apache-2.0)
- **Conceito:** `{{node}}`, `{{node:3}}`, `{{node:all}}`, `{{@template}}`, `{{a:2|b:3}}` —
  o autor declara o que cada nó recebe, em vez de o runtime empurrar histórico.
- **Reaproveitamento:** **Inspirar** (reimplementar, ~150 linhas)
- **Mudanças:** estender `executionContext()` (`src/core/task-plan.ts:5-30`) — que hoje
  entrega `activeStory` + `lastReviewFindings` — para resolver referências declaradas por
  story; prompts em `prompts-src/`.
- **Benefício:** resposta direta ao "transportar evidência entre nós sem carregar todo o
  contexto" de `#116`; mensurável em contexto médio por chamada.
- **Complexidade:** Média · **Riscos:** placeholder apontando para story não executada
  precisa falhar na validação do plano, não em runtime.

### 7.5 `WorktreeHygiene` — classificador puro

- **Origem:** GraphCode · `Domain/WorktreeHygiene.swift` (271 linhas, MIT, só `Foundation`)
- **Conceito:** classificar cada worktree em `safeToRemove` / `lookBeforeRemoving` /
  `inUse` a partir de fatos lidos do git (incluindo detecção de squash-merge e untracked
  como sujeira), com a lógica **pura** e testável sem repositório.
- **Reaproveitamento:** **Adaptar** (porte próximo de 1:1, ~200 linhas de TS)
- **Mudanças:** `src/utils/git.ts` colhe os fatos, classificador puro ao lado; hoje
  `worktree` só aparece como allow-list de `remove`/`prune` em `src/utils/shell.ts:146`.
- **Benefício:** pré-requisito de segurança para qualquer paralelismo isolado (`#116`) —
  e resolve sozinho a limpeza de branches de execuções antigas.
- **Complexidade:** Média · **Riscos:** nenhum relevante; é leitura + classificação.

### 7.6 `LoopState` e `AttentionRollup`

- **Origem:** GraphCode · `Domain/LoopState.swift`, `Domain/AttentionRollup.swift` (MIT)
- **Conceito:** estados de nó de primeira classe — com `waiting` (fez a sua parte, espera
  dependentes), `stalled` (gastou sem aprender) e `stopped` (humano parou ≠ falhou) — e
  uma fila de atenção ordenada pior-primeiro para ler, mais-antigo-primeiro para trabalhar.
- **Reaproveitamento:** **Adaptar**
- **Mudanças:** hoje o nível de story tem só `passes: boolean` decidindo fluxo
  (`status`/`stage` são observacionais); o nível de fila já tem `QueueIssueStatus` com 6
  estados. Isto **alinha os dois níveis** e alimenta o painel (`src/web/`).
- **Benefício:** explicitude de estado — um dos eixos de sucesso declarados em `#116`.
- **Complexidade:** Média (toca `tasks.json` → exige campo novo preservando desconhecidos)
- **Riscos:** contrato público; migrar com decode tolerante (item 7.7).

### 7.7 Dois detalhes de robustez, custo quase zero

- **Decode tolerante a versão** — GraphCode · `Domain/LoopEdge.swift:88-160`: campo novo
  decodifica com default em vez de derrubar o arquivo inteiro; chave legada é **lida e
  nunca reescrita**. Nossa regra "preservar campos desconhecidos" ganha a metade que falta:
  *nunca falhar o load por campo ausente*. **Inspirar**, ~20 linhas em `src/schemas.ts`.
- **Exit codes 69/75** — GraphCode · `graphcode-cli/Sources/main.swift:13-24`:
  `EX_UNAVAILABLE` (nada foi escrito, retry seguro) vs `EX_TEMPFAIL` (pode ter sido
  aplicado, **não** repetir cegamente). **Absorver** em `docs/commands.md` — a distinção
  que decide se um wrapper pode repetir, hoje ausente da nossa tabela de exit codes.

### O que eu **não** incorporaria agora

- Grafo de código (RepoGraph e sucessores): o Issue Flow ainda não tem o problema de
  "achar o arquivo certo em 10k arquivos" — ele recebe uma issue e um plano. Antes disso,
  medir se localização é gargalo. Se for, a base é `tree-sitter` + `tags.scm` oficiais,
  não o RepoGraph.
- Qualquer coisa do agent-graph além das três ideias: a plataforma inteira é acoplada a
  Mongo/MinIO/FastAPI.
- Mailroom / sessões vivas / zmx: é a pergunta de `#124`, com licença FSL por cima.

---

## 8. Arquitetura consolidada proposta

Nada aqui é motor novo; é a explicitação de primitivas que já existem, com as peças
acima encaixadas.

```text
Issue Flow (TypeScript, Skills + CLI)
│
├── Camada de contrato (regras puras, testáveis sem I/O)      ← o que absorvemos
│   ├── CycleGuard          ← GraphCode (MIT)   liga em routing/escalation.ts
│   ├── EdgeCondition       ← GraphCode (MIT)   always | onSuccess | onFailure
│   ├── PayloadTransform    ← GraphCode (MIT)   none | template | script
│   ├── NodeState           ← GraphCode (MIT)   alinha story ↔ QueueIssueStatus
│   ├── WorktreeAssessment  ← GraphCode (MIT)   safe | lookBefore | inUse
│   └── ContextProjection   ← agent-graph       {{story}} {{story:N}} {{@template}}
│
├── Camada de execução (o que já temos, agora ligada)
│   ├── task-plan.ts        eligibleStories() já calcula o ready set completo —
│   │                       executionContext() para de reduzir a ready[0]
│   ├── engine.ts           consome CycleGuard em vez de maxCorrectionCycles global
│   ├── routing/escalation  detectNonConvergence()/nextRung() ganham call site
│   └── verify/             contrato de aceitação passa a usar o avaliador único
│
├── Camada de evidência (já existe)
│   └── journal.ts · events.jsonl · SQLite · telemetry/  ← UsageSample: reportado, nunca estimado
│
└── Camada de isolamento (nova, pré-requisito de paralelismo)
    └── worktree add/list/remove + WorktreeAssessment
        serial continua sendo o fallback quando o isolamento não é garantido
```

**Ordem de prioridade para experimentar**

| # | Item | Depende de | Prova o quê |
|---|---|---|---|
| 1 | `ShellPredicate` + avaliador único (7.2) | — | Gate determinístico com evidência de falha realimentada |
| 2 | `CycleGuard` ligado à escalada (7.1) | 1 | Orçamento e platô por nó; ativa código morto testado |
| 3 | Decode tolerante + exit codes (7.7) | — | Robustez a custo ~zero, destrava 6 |
| 4 | `ContextProjection` (7.4) | — | Redução mensurável de contexto por chamada |
| 5 | `WorktreeAssessment` (7.5) | — | Pré-requisito de segurança para paralelismo |
| 6 | `NodeState` + `AttentionRollup` (7.6) | 3 | Explicitude de estado; alimenta o painel |
| 7 | Handoff como tool call (7.3) | `AgentCapabilities` | Roteamento condicional sem parsing de prosa |
| 8 | Ready set > 1 + fan-out em worktree | 2, 5, 6 | O experimento que `#116` existe para decidir |

**Critério de rejeição (o mesmo de `#116`):** cada item entra apenas se melhorar de forma
medida custo por mudança aceita, tempo total, retrabalho, contexto por chamada ou
verificabilidade. Uma arquitetura 3× mais rápida com retrabalho desproporcional deve ser
rejeitada — e concluir que um destes sete não vale o custo é resultado válido, desde que
registrado com a razão.

---

## 9. Procedência

Todos os repositórios foram clonados e lidos em 2026-09-06.

| Repositório | Commit inspecionado | Licença | Escopo lido |
|---|---|---|---|
| DEEP-JLU/Awesome-Graph-Engineering | `297de53` (2026-09-05) | MIT | `README.md` integral |
| ozyyshr/RepoGraph | `6c3977d` (2025-04-01) | Apache-2.0 | `repograph/*` integral; integração Agentless/SWE-agent; issues #10, #18 |
| keta1930/agent-graph | `0e5cc73` (2026-08-09) | Apache-2.0 | `models/graph_schema.py`, `services/graph/*`, `utils/output_tools.py`, `services/system_tools/*`, `pyproject.toml`, `tests/`, CI |
| scgopi/GraphCode | `a5f4e1e` (2026-09-05, v0.1.63) | MIT + FSL-1.1-MIT | `LICENSE`, `GraphcodeKit/Sources/Domain/*`, `Sessions/ShellPredicateEvaluator.swift`, `GraphStore.swift` (parcial), `graphcode-cli/`, `README.md`, issues |

Estado do Issue Flow verificado nesta análise: ausência de cache de resultado por conteúdo
(`createHash` só em ETag do monitor, identidade de projeto e `issues/hash.ts`); ausência de
isolamento por worktree (`src/utils/shell.ts:146` permite apenas `remove`/`prune`);
ausência de invalidação por dependentes; `executionContext()` reduzindo o ready set a
`ready[0]` (`src/core/task-plan.ts:5-30`); `detectNonConvergence`/`nextRung` sem call site
fora de `routing/escalation.test.ts`.
