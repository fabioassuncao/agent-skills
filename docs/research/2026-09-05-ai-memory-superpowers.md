# AI Memory e Superpowers no fluxo agêntico do Issue Flow

- **Data da pesquisa:** 2026-09-05
- **Issue Flow analisado:** `3df2696a2e7c7fb3f76ccf42e62309960ac5d22a`,
incluindo o working tree associado à pesquisa `#107` e ao PR `#109`, ainda fora
  do commit base local no momento desta análise
- **AI Memory analisado:** `f830c610f7d1ee920c2e28233e26e459bb41ed06`
  (`2.0.3`)
- **Superpowers analisado:** `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`
  (`6.3.0`)

Esta é uma pesquisa datada, não uma especificação normativa. As regras atuais
continuam nos documentos e `AGENTS.md` próprios de cada módulo.

## Decisão

### AI Memory: realizar spike, sem adotar ainda

O AI Memory tem aderência real como uma fonte **opcional e somente leitura de
conhecimento histórico validado do repositório**. Ele oferece busca híbrida,
proveniência, relações, versionamento, expiração, feedback de informação
incorreta e handoffs tipados que o Issue Flow não deve reconstruir sem evidência
de necessidade.

Ele não deve:

- substituir SQLite, `tasks.json`, `session.json`, eventos, locks ou Git;
- decidir fase, retry, approval, commit, PR ou conclusão;
- lançar ou retomar coding agents por `ai-memory run`;
- capturar automaticamente prompts, comandos e patches no primeiro experimento;
- sincronizar implicitamente os artefatos da CLI e das Agent Skills;
- ser tratado como índice autoritativo do código atual.

O spike deve provar ganho em tarefas reais do Issue Flow antes de introduzir uma
porta permanente no núcleo. Se não melhorar recuperação, qualidade ou consumo
de contexto de forma mensurável, a decisão é manter apenas os conceitos de
proveniência, promoção e invalidação.

### Superpowers: adaptar conceitos, sem adotar o framework

O Superpowers não deve ser instalado como dependência ou bootstrap obrigatório
do Issue Flow. Sua política global, referências cruzadas entre skills, gates
interativos e controle de worktrees/subagentes competem com responsabilidades já
possuídas pela CLI e reduzem a portabilidade independente das skills.

Devem ser adaptados, nesta ordem:

1. testes comportamentais de descoberta e execução das Agent Skills;
2. validação técnica de feedback antes de aplicá-lo;
3. evidência fresca antes de declarar uma tarefa concluída;
4. regressão reproduzível antes da correção de bugs, quando as convenções do
   repositório permitirem;
5. pacotes de contexto pequenos e explícitos para investigação e review.

Worktrees, subagentes de implementação e execução paralela permanecem apenas
referências para uma evolução posterior. O modelo transacional atual usa um
`run.lock` por projeto e uma única árvore de trabalho; copiar uma skill não
remove esse limite.

## Método e fontes

A análise combinou:

- código, documentação, migrations, prompts, Agent Skills e `AGENTS.md` do
  Issue Flow;
- pesquisas arquiteturais anteriores, especialmente
  [orquestração multi-harness](2026-08-30-multi-harness-orchestration.md) e
  [continuidade entre iterações e superfícies](2026-09-05-pipeline-iterations-corrections-continuity.md);
- issues abertas e fechadas, buscadas pelo problema representado e não apenas
  por palavras-chave;
- documentação e implementação dos dois projetos, fixadas nos commits acima;
- artigo do AI Memory como contexto de intenção, conferindo as afirmações
  relevantes no código ou na documentação do repositório;
- benchmarks publicados pelos próprios projetos, tratados como evidência de
  mecanismo, não como prova de impacto no Issue Flow.

## Arquitetura atual do Issue Flow

O Issue Flow tem duas superfícies públicas relacionadas, mas independentes:

- a CLI, que orquestra o pipeline completo e persiste seu estado globalmente;
- dez Agent Skills portáveis, que podem ser usadas sem a CLI em diferentes
  coding agents.

A CLI possui runners para Claude Code, Codex, Cursor e Antigravity. OpenCode e
Gemini entram hoje pela superfície portátil das Agent Skills, não como
`AgentRunner` do pipeline. Uma integração de memória não deve apagar essa
diferença nem prometer suporte de orquestração que o núcleo ainda não possui.

### Responsabilidades existentes

| Responsabilidade | Implementação atual | Consequência para esta decisão |
| --- | --- | --- |
| Fonte transacional | SQLite, com projeções JSON compatíveis | memória externa não pode substituir nem reconciliar esse estado |
| Histórico operacional | execuções, fases, eventos, snapshots, reviews, verificações e PRs | serve para auditoria e retomada do workflow, não como memória semântica |
| Continuidade da execução | `tasks.json`, `progress.txt`, Git, `session.json` e eventos | a próxima invocação não depende de uma sessão nativa do provider |
| Isolamento atual | `run.lock` por projeto e uma árvore de trabalho | não há execução paralela segura no mesmo repositório hoje |
| Agentes/harnesses | `AgentRunner` intercambiável, seleção por fase, failover e health | outro orquestrador de sessões criaria dupla autoridade |
| Verificação | acceptance checks objetivos antes do reviewer independente | memória e review LLM não podem tornar evidência objetiva opcional |
| Convenções | descoberta limitada de `AGENTS.md`, `CLAUDE.md` e documentação | é recuperação textual determinística, não RAG semântico |
| Skills | pacotes autocontidos, sem dependência obrigatória da CLI/MCP | referências cruzadas ou bootstrap específico de harness são regressões |
| Skills → CLI | adoção única de artefatos locais para o storage global | não existe sincronização bidirecional nem retomada universal de sessão |
| CLI → Skills | não existe handoff operacional reverso | um resumo de memória não reconstrói locks, checkpoints ou approvals |

O desenho deliberado é de invocações headless descartáveis. Cada fase e cada
iteração de execução recebem contexto reconstruído de artefatos duráveis. Isso
reduz o valor marginal de sessões nativas persistentes e preserva retry,
failover, auditabilidade e troca de harness.

### Lacunas reais

1. Decisões e aprendizados de várias issues não são recuperáveis por significado.
   Eles só são encontrados se estiverem em documentação conhecida ou se o agente
   souber o termo e o caminho corretos.
2. `progress.txt` funciona como memória episódica da issue, mas é linear,
   local e não consolidado.
3. A continuidade entre Agent Skills e CLI é uma adoção em sentido único; não é
   um protocolo geral de handoff entre superfícies.
4. A validação estrutural das skills está sendo fortalecida, mas ainda não há
   evals comportamentais que meçam descoberta, não ativação indevida e adesão às
   instruções em diferentes harnesses.
5. O projeto não possui isolamento por worktree nem concorrência de escrita no
   mesmo projeto.

As lacunas 1 e parte da 2 são candidatas ao AI Memory. A lacuna 4 recebe a
contribuição mais concreta do Superpowers. As lacunas 3 e 5 são problemas de
protocolo e estado transacional; nenhuma das ferramentas as resolve por si só.

## Memória, contexto, recuperação e estado transacional

Os termos não são intercambiáveis.

| Camada | Exemplos | Autoridade | Persistência recomendada |
| --- | --- | --- | --- |
| Estado transacional | issue ativa, fase, status, dependências, lock, approval, tentativa, checkpoint, commit, PR | Issue Flow | SQLite + projeções/artefatos e Git |
| Histórico operacional | início/fim de fase, falha classificada, métricas, review, verificação | Issue Flow | eventos, snapshots e tabelas operacionais |
| Contexto temporário | prompt atual, saída recente, diff sob análise, arquivos abertos | invocação atual | memória da sessão; descartável |
| Memória episódica | tentativas anteriores, decisões locais da issue, próximos passos, handoff | artefato da execução até validação | `progress.txt`/handoff; TTL ou arquivamento |
| Conhecimento durável | decisão arquitetural, padrão confirmado, gotcha recorrente, explicação consolidada | documentação do projeto | docs/ADRs/`AGENTS.md`; índice derivado opcional |
| Recuperação documental | localizar uma regra ou documento atual | arquivo versionado | busca textual, links e descoberta de convenções |
| Inteligência de código | símbolos, referências, tipos, dependências do checkout atual | código no commit atual | `rg`, parser, LSP ou índice de código |
| Recuperação semântica | achar conhecimento histórico sem conhecer seus termos exatos | evidência não autoritativa | provider de memória opcional |

Uma resposta de memória é **evidência histórica não confiável por padrão**. Deve
carregar origem, versão e escopo e ser conferida contra o checkout, a issue e as
regras atuais. Encontrar algo por similaridade não transforma o conteúdo em
verdade operacional.

### Invariante de autoridade

```text
SQLite / tasks / eventos / Git
        │
        ├── constroem o envelope transacional da fase
        │
        └── nunca são derivados de uma resposta de memória

memória opcional ──recall──> evidências com proveniência
                              │
                              └── contexto limitado para o agente

saída do agente ──> validação objetiva/review ──> transação do Issue Flow
                 └─> candidato de conhecimento ──> validação/aprovação ──> docs/memória
```

Falha, indisponibilidade ou desativação da memória não pode impedir o pipeline
nem mudar o estado já persistido.

## AI Memory

### Arquitetura e modelo de dados

O AI Memory 2.0 é um servidor nativo em Rust com interfaces MCP, HTTP e CLI. Seu
modelo separa:

- páginas Markdown versionadas por Git como fonte da verdade do conhecimento;
- segmentos brutos e imutáveis de observações sanitizadas;
- SQLite como índice derivado de texto completo, entidades, links e embeddings;
- sessões, handoffs e workstreams para continuidade entre agentes;
- modelos locais, logs e configuração em um diretório de dados próprio.

Essa separação é saudável para conhecimento: o formato legível e versionável
continua acessível sem o banco, e o índice pode ser reconstruído. Não torna o
sistema apropriado para transações do Issue Flow: páginas Git e um índice de
busca não oferecem as invariantes de fila, lock, retry, fase e publicação do
pipeline.

### Captura, consolidação e atualização

Hooks podem enviar eventos de início/fim de sessão, prompts, chamadas de
ferramenta, compactação e observações. Ao final da sessão, o servidor produz
sumário e handoff por regras; uma etapa LLM opcional consolida conceitos,
decisões e gotchas.

O sistema oferece:

- cadeias de versão e `supersedes`;
- indicação de informação mais recente;
- feedback de conteúdo stale ou incorreto;
- TTL, decaimento, pin e tombstones;
- relações tipadas, inclusive contradição;
- validade temporal de links de entidades baseada em ingestão/versão;
- proposals de auto-improvement, com aprovação opcional.

A temporalidade é útil, mas não é um ledger bitemporal completo de fatos do
mundo. E o padrão de autoaprovação de propostas não atende à barra de confiança
do Issue Flow. Se uma escrita futura for testada, `require_approval` deve ser
obrigatório e a promoção deve depender de validação independente.

### Recuperação

A consulta combina, por Reciprocal Rank Fusion:

- FTS5;
- busca lexical de entidades;
- vizinhança de grafo;
- embeddings opcionais;
- multiplicador de autoridade;
- reranker LLM opcional.

Também há filtro por projeto/workspace, múltiplos scopes, `as_of`, inclusão de
expirados e explicação dos resultados. O modelo local de embeddings evita
egress, mas baixa e mantém em memória um `all-MiniLM-L6-v2` de aproximadamente
87 MB e limita entradas a 512 tokens.

O benchmark publicado usa 470 consultas do LongMemEval-S. O repositório reporta
`hit@5` de 0,617 com FTS e 0,823 com o embedding local atual, com `recall@5` de
0,680. Esses números mostram que o mecanismo recupera memória sintética melhor
com embeddings; não demonstram melhora em acerto de implementação, tempo, tokens
ou custo no Issue Flow. O artigo registrava 0,779 antes das revisões posteriores,
o que também mostra que números de uma versão jovem mudam rapidamente.

### Handoff

O handoff tipado contém agente/sessão de origem, destino opcional, diretório,
sumário, perguntas abertas, próximos passos e arquivos tocados. Ele possui estados
aberto, aceito e expirado e semântica de aceitação única.

Isso pode melhorar um pacote de contexto entre agentes independentes. Não é um
bus de coordenação e não contém as transações necessárias para retomar uma
execução do Issue Flow. A adoção única Skills → CLI definida em `#107` continua
sendo um protocolo separado.

### Identidade, worktrees e concorrência

Por padrão, workspace é `default` e projeto é o basename do diretório atual.
Isso pode colidir entre repositórios de mesmo nome ou fragmentar subdiretórios e
worktrees. A configuração permite marcador explícito ou estratégia `repo-root`;
esta última faz worktrees ligadas compartilharem o projeto.

O Issue Flow usa uma identidade determinística baseada no remote Git. Um spike
deve mapear essa identidade explicitamente, nunca inferir o namespace pelo
basename.

As consultas comuns são isoladas por workspace/projeto, mas não possuem filtro
forte por issue, execução ou prefixo de página. Workstreams têm fingerprint de
repositório e worktree e usam lease, porém são também o mecanismo que lança e
retoma sessões nativas dos harnesses. Usá-los colocaria AI Memory e Issue Flow no
papel de orquestrador simultaneamente.

Consequências:

- conhecimento validado do projeto pode ser compartilhado entre worktrees;
- evidência temporária de issue/execução não deve entrar no índice comum no
  primeiro spike;
- branch e worktree são localizadores, não donos do conhecimento durável;
- handoffs devem ser privados à execução até serem aceitos e validados;
- `ai-memory run` e managed workstreams ficam fora da integração.

O servidor usa um writer SQLite, WAL e um único Git handle por diretório de
dados. O projeto publica bom throughput concorrente em testes próprios, mas isso
não resolve conflitos semânticos entre agentes. A consistência de significado
precisa de promoção, revisão e supersessão explícitas.

### Integrações e portabilidade

Hooks e adaptadores cobrem Claude Code, Codex, OpenCode e vários outros
harnesses. O protocolo MCP permite acesso desacoplado, e as próprias Agent Skills
do AI Memory ensinam quando consultar ou escrever.

Para o Issue Flow, a integração correta seria a CLI construir consultas e anexar
evidências ao prompt. As Agent Skills podem documentar uma integração MCP
**opcional**, com fallback para arquivos e busca local. Tornar o MCP obrigatório
violaria a independência hoje prevista em `docs/skills.md`.

### Segurança, privacidade e operação

Riscos relevantes:

- hooks podem capturar prompts, comandos, patches e respostas com segredos;
- exclusões por caminho são uma proteção lexical, explicitamente não DLP;
- texto livre, comandos shell e aliases por symlink não são atribuíveis de forma
  segura a um caminho;
- embeddings ou LLM remotos criam egress e custo;
- no modo de equipe não há ACL por página: membros autenticados podem alterar
  páginas do projeto;
- memória recuperada pode conter instrução obsoleta ou maliciosa;
- um servidor compartilhado amplia o raio de exposição entre máquinas e times.

O primeiro spike deve, portanto, usar corpus curado, servidor local, sem hooks,
sem LLM, sem egress, sem escrita pelo agente e sem dados privados reais. Uma
eventual implantação precisa de retenção, backup, autenticação, audit trail,
redação de segredos e modelo de ameaça próprios.

### Maturidade, licença e lock-in

O projeto é MIT, usa Markdown/Git como fonte legível e oferece MCP, reduzindo
lock-in de dados e protocolo. Porém o repositório nasceu em maio de 2026 e a série
2.0 recebeu quatro releases entre 2 e 4 de setembro. A atividade é positiva, mas
o contrato ainda está estabilizando.

O lock-in relevante não está nos arquivos Markdown; está na semântica dos hooks,
handoffs, relações, ranking, configuração e operação do servidor. Isso justifica
um experimento reversível, não uma adoção direta.

### O que ele resolve e o que não resolve

| Necessidade | AI Memory | Decisão |
| --- | --- | --- |
| recuperar decisões históricas por significado | resolve tecnicamente | medir em tarefas reais |
| consolidar aprendizados entre sessões/máquinas | resolve com governança | testar apenas leitura curada primeiro |
| handoff humano/agente tipado | resolve contexto | considerar depois do recall |
| invalidar/superseder conhecimento | oferece mecanismos úteis | adaptar promoção e proveniência |
| buscar o código atual com precisão estrutural | não resolve | manter `rg`/LSP/parser/checkout |
| retomar fase/checkpoint/retry | não resolve | manter storage transacional |
| sincronizar CLI e skills | não resolve | manter protocolo explícito separado |
| coordenar worktrees | workstreams se sobrepõem ao orquestrador | não integrar |
| impedir contaminação entre issues | escopo nativo é insuficiente | limitar corpus ou exigir extensão comprovada |

## Superpowers

### Modelo

O Superpowers é uma metodologia distribuída em skills composáveis, acompanhada
por adapters de instalação e bootstrap para diferentes harnesses. Seu fluxo
típico é:

```text
brainstorming → design → plano → worktree → execução/TDD
             → review → processamento de feedback → conclusão da branch
```

O bootstrap `using-superpowers` exige invocar uma skill antes de qualquer ação
quando houver até baixa chance de aplicabilidade. Claude e Cursor recebem a
instrução por hook de sessão, inclusive após compactação; OpenCode e outros usam
plugins/extensões próprios. Isso é eficaz para a metodologia daquele projeto,
mas é uma camada específica de harness além da especificação portátil de Agent
Skills.

### Comparação por conceito

| Conceito | Issue Flow hoje | Avaliação |
| --- | --- | --- |
| Descoberta/bootstrap | instalação por harness e descrições portáveis | o bootstrap coercitivo do Superpowers não deve ser copiado |
| Progressive disclosure | `SKILL.md` + referências/scripts autocontidos | já implementado adequadamente |
| Brainstorming/design | análise + PRD; perguntas só quando necessário | parcial; adaptar design explícito apenas para trabalho arquitetural/ambíguo |
| Planejamento | PRD + `tasks.json` com histórias verificáveis | já implementado adequadamente; preservar formato machine-readable |
| Execução de plano | uma história por invocação, progresso e commit | equivalente na essência; aproveitar pacotes de contexto pequenos |
| Continuidade pós-compactação | artefatos e nova invocação, sem depender do chat | arquitetura do Issue Flow é mais independente do harness |
| TDD | segue convenções e testes do repositório | adaptar regressão-first para bugs, não impor TDD universal |
| Debug sistemático | não há skill dedicada | candidato futuro após existir eval comportamental |
| Verificação antes de concluir | acceptance checks + review independente | forte na CLI; explicitar evidência fresca nas skills independentes |
| Code review | `review-issue`, `review-pr` e reviewer independente | já implementado adequadamente |
| Receber feedback | correction loop e findings persistidos | parcial; falta exigir reprodução e julgamento técnico antes da mudança |
| Subagentes | não há abstração comum entre harnesses | não adotar SDD agora; custo e ownership duplicariam o AgentRunner |
| Paralelismo | filas sequenciais e lock por projeto | incompatível para implementação no mesmo checkout hoje |
| Worktrees | não implementado | usar apenas como referência para futuro desenho transacional |
| Finalização de branch | pipeline determinístico até PR | a skill interativa do Superpowers conflita com o fluxo headless |
| Criação de skills | regras de portabilidade e validação estrutural | Issue Flow é mais rigoroso em autocontenção |
| Testes/evals de skills | estrutura, links, tamanho e contratos compartilhados | comportamento está ausente; Superpowers oferece o melhor padrão a adaptar |

### Portabilidade das skills

As skills do Superpowers são MIT e tecnicamente legíveis, mas não são copiáveis
diretamente para o contrato do Issue Flow:

- várias referenciam outras por nome `superpowers:*`;
- algumas usam caminhos `../` para conteúdo irmão;
- o comportamento completo depende de hooks/plugins de bootstrap;
- certas etapas assumem uma API de subagentes ou worktrees do harness;
- brainstorming e finalização exigem interação humana como gate universal.

O Issue Flow exige que cada skill publicada seja instalável sozinha, não use
frontmatter proprietário, mantenha referências dentro do próprio diretório e
funcione com filesystem/Git/`gh` quando a CLI ou MCP não existirem. Para essa
meta, o contrato do Issue Flow deve prevalecer.

### Conceitos a adaptar

#### 1. Evals comportamentais de skills

O Superpowers trata documentação de skill como código: cria cenários de pressão,
observa falhas sem a skill, adiciona instrução mínima e repete com ator e
verificador. Seus evals reais são lentos e ficam fora do CI normal.

Aplicação recomendada:

- manter validação estrutural rápida em todo PR;
- criar cenários positivos e negativos de ativação;
- avaliar aderência ao resultado, não frases exatas;
- executar smoke evals de baixo custo sob demanda ou nightly;
- cobrir ao menos Claude, Codex, Gemini e OpenCode conforme disponibilidade;
- registrar modelo, versão, duração, tokens e resultado para detectar regressão;
- separar eval da skill para não tornar o pacote publicado dependente do runner.

#### 2. Feedback tecnicamente verificado

Findings de review não devem ser aceitos por deferência. Antes de corrigir, o
executor deve reproduzir, conferir o checkout, detectar conflito com a issue e
registrar quando o feedback é inválido ou supersedido. Isso cabe no contrato
existente de `execute-tasks`/correction loop.

#### 3. Evidência fresca

Uma conclusão precisa citar a verificação executada depois da mudança relevante.
O conceito já existe na CLI; deve ser reforçado nos resultados das skills para
evitar que uma execução independente confunda intenção ou teste antigo com
evidência atual.

#### 4. Regressão antes da correção

Para bugs reproduzíveis, escrever ou demonstrar uma verificação que falha antes
da correção reduz falsos positivos. A regra deve respeitar as convenções e o
risco do repositório; impor TDD completo a todo tipo de tarefa seria inadequado.

#### 5. Pacotes de contexto e ledger

O SDD do Superpowers mantém brief, respostas, reviews e rulings em arquivos para
reduzir o contexto do controlador e sobreviver a compactações. O Issue Flow já
tem `tasks.json`, `progress.txt`, eventos e review findings. Deve reutilizar esses
artefatos, acrescentando somente campos ou relatórios cuja necessidade seja
medida, em vez de criar um segundo ledger `.superpowers/`.

### Conceitos não adotados agora

- bootstrap global e regra de invocação a 1%;
- dependência runtime do repositório Superpowers;
- brainstorming interativo obrigatório para qualquer mudança;
- `subagent-driven-development` como executor do pipeline;
- review duplo por história antes de benchmark de custo/benefício;
- criação automática de worktrees por uma skill;
- decisão interativa de merge/PR fora da política do Issue Flow;
- TDD universal sem considerar convenções e tipo de tarefa.

## Relação entre as duas iniciativas

Elas tratam camadas diferentes e podem coexistir sem se conhecer:

```text
Issue Flow
├── estado transacional e orquestração (autoritativo)
├── Agent Skills portáveis (processo e instruções)
├── AgentRunner/harnesses (execução descartável)
└── contexto opcional
    └── AI Memory (evidência histórica, se o spike for aprovado)
```

As skills podem ensinar o agente a avaliar proveniência e promover conhecimento;
o provider pode recuperar a evidência. Nenhum dos dois deve escrever
implicitamente o estado do outro.

## Arquitetura proposta para o spike de memória

Não criar `NativeMemoryProvider` agora: o Issue Flow não possui uma implementação
nativa equivalente, e inventar três providers antes de validar o primeiro seria
overengineering.

O spike deve usar um adapter local e estreito. Somente se aprovado, extrair uma
porta com semântica de recuperação, não um armazenamento genérico:

```ts
type MemoryScope = {
  projectId: string;
  issueId?: string;
  executionId?: string;
  branch?: string;
  worktree?: string;
};

type MemoryEvidence = {
  text: string;
  source: string;
  version?: string;
  scope: MemoryScope;
  score?: number;
  retrievedAt: string;
};

interface KnowledgeContext {
  recall(scope: MemoryScope, query: string, budget: number): Promise<MemoryEvidence[]>;
}
```

Características obrigatórias de uma implementação posterior:

- configuração `none` e comportamento fail-open;
- orçamento explícito de resultados/tokens;
- project id canônico do Issue Flow;
- proveniência e versão em cada evidência;
- nenhuma operação de fase, fila, lock ou status;
- nenhuma captura automática como efeito colateral de `recall`;
- telemetria de latência, hits usados e falhas sem registrar conteúdo sensível;
- adapter substituível nos testes, sem prometer providers hipotéticos.

### Namespaces e promoção

| Dimensão | Compartilhamento | Uso na memória |
| --- | --- | --- |
| projeto/repositório | compartilhado por issues e worktrees | conhecimento durável validado |
| issue | isolado por padrão | memória episódica e candidatos |
| execução | isolada | tentativas, open questions e handoff |
| worktree/branch | isolam o checkout, não o conhecimento | metadado para validar atualidade |
| agente/harness | não deve possuir conhecimento do projeto | atribuição e auditoria |
| sessão | privada e descartável | contexto temporário; handoff explícito |

O ciclo de promoção recomendado é:

```text
observação temporária
  → candidato com origem
  → validação contra código/docs/testes atuais
  → review ou aprovação
  → conhecimento durável do projeto
  → supersessão/expiração quando contradito
```

No spike, apenas o último nível entra no AI Memory. Essa restrição contorna a
ausência atual de filtro forte por issue/execução e impede contaminação entre
agentes paralelos.

## Opções consideradas

### A. Adotar integralmente AI Memory e Superpowers

Rejeitada. Criaria dois novos centros de controle para sessões, worktrees,
planejamento e estado, duplicando AgentRunner, storage, skills e pipeline.

### B. Implementar memória/RAG próprio no Issue Flow

Rejeitada antes de benchmark. Armazenamento híbrido, embeddings, versionamento,
relações e invalidação são capacidades maduras o bastante no ecossistema para
serem integradas quando necessárias. Código próprio só se justifica se as
restrições do spike tornarem os providers existentes inadequados.

### C. Integrar AI Memory diretamente ao núcleo agora

Rejeitada. O projeto é jovem, o isolamento por issue não atende ao uso amplo e
o benefício para tarefas de software ainda não foi medido.

### D. Spike de recall curado + adaptação seletiva das skills

Recomendada. É reversível, preserva as fontes de verdade atuais e testa as duas
hipóteses de maior valor com escopo observável.

## Matriz de aderência

| Capacidade | Issue Flow hoje | Ferramenta | Aderência | Estratégia recomendada |
| --- | --- | --- | --- | --- |
| memória entre sessões | artefatos por issue; sem recuperação semântica | AI Memory | alta para conhecimento, baixa para estado | realizar spike read-only |
| conhecimento entre issues | docs manuais e busca textual | AI Memory | alta | integrar só se benchmark provar valor |
| handoff entre harnesses | arquivos/Git e adoção Skills → CLI | AI Memory | média | adaptar formato; não substituir protocolo |
| estado do workflow | SQLite, eventos, snapshots e JSON | AI Memory | incompatível | não utilizar |
| retomada transacional | checkpoints e artefatos do Issue Flow | AI Memory | incompatível | não utilizar |
| busca textual | `rg`, FTS possível no provider | AI Memory | média | manter local; comparar no spike |
| busca semântica | ausente | AI Memory | alta | testar embeddings locais |
| indexação de código atual | busca direta, sem índice semântico | AI Memory | baixa | usar ferramenta própria de código se necessária |
| contradição/supersessão | Git e edição manual de docs | AI Memory | média/alta | adaptar modelo de promoção |
| múltiplas máquinas | storage local do Issue Flow | AI Memory | média | fora do primeiro spike; avaliar segurança depois |
| isolamento entre issues | diretórios/execuções, lock por projeto | AI Memory | baixa no recall comum | corpus curado; bloquear memória episódica compartilhada |
| planejamento | PRD + `tasks.json` | Superpowers | média, já coberta | adaptar apenas preflight/clareza |
| design/brainstorming | parcial | Superpowers | média | design condicional, sem gate global |
| execução iterativa | uma história por sessão | Superpowers | alta sobreposição | não duplicar; aproveitar briefs compactos |
| TDD | dependente do repositório | Superpowers | média | adaptar regressão-first para bugs |
| debugging sistemático | sem skill específica | Superpowers | média | candidato após evals |
| verificação | forte na CLI, parcial nas skills | Superpowers | alta | reforçar evidência fresca nas skills |
| code review | dois tipos de review + acceptance | Superpowers | baixa vantagem incremental | manter arquitetura atual |
| processamento de feedback | correction loop | Superpowers | média/alta | adaptar validação e rulings |
| subagentes | sem abstração comum | Superpowers | baixa hoje | referência futura e benchmark |
| trabalho paralelo | fila sequencial | Superpowers | baixa hoje | não adotar antes de worktrees/estado |
| Git Worktrees | ausente | Superpowers | referência útil | usar em desenho futuro, não como skill isolada |
| bootstrap pós-compactação | reconstrução por artefatos | Superpowers | incompatível como requisito | manter independência de sessão |
| portabilidade das skills | contrato autocontido multi-harness | Superpowers | Issue Flow é mais aderente | não copiar referências cruzadas/plugins |
| testes estruturais de skills | presentes/em implantação | Superpowers | complementar | manter |
| evals comportamentais de skills | ausentes | Superpowers | alta | implementar abordagem adaptada |

## Build vs. integrate vs. adapt

| Capacidade | Implementar internamente | Integrar | Adaptar conceito | Não utilizar |
| --- | --- | --- | --- | --- |
| busca híbrida e embeddings | não antes do benchmark | AI Memory opcional, se aprovado | proveniência/orçamento | — |
| armazenamento/versionamento de conhecimento | docs/Git continuam canônicos | possivelmente AI Memory como índice | promoção/supersessão | — |
| estado de pipeline | Issue Flow | — | — | AI Memory |
| managed workstreams | — | — | fingerprints/lease como referência | AI Memory `run` |
| handoff | manter contrato do Issue Flow | talvez consumir/exportar depois | campos tipados e expiração | usar como estado |
| bootstrap de skills | discovery nativa por harness | — | descrição/trigger testáveis | bootstrap Superpowers |
| evals de skills | runner/casos do Issue Flow | reutilizar apenas ideias/infra licenciada útil | red-green para instruções | — |
| revisão de feedback | contratos existentes | — | verificar antes de mudar | — |
| worktrees | futura alteração transacional própria | — | práticas de segurança do Superpowers | criação autônoma hoje |

## Relação com decisões e issues existentes

- `#10` fixou a CLI headless com sessões isoladas e retomada por artefatos. O
  AI Memory não justifica reverter essa decisão.
- `#61` estabeleceu paridade entre Agent Skills e CLI. A adaptação do
  Superpowers deve fortalecer a interface portátil, não criar dependência da CLI.
- `#66` e `#91`–`#95` definiram journal, `runState`, SQLite e projeções. Essas
  issues são a fronteira transacional que a memória não atravessa.
- `#77` e `#57` consolidaram descoberta de convenções e documentação. Memória
  pode indexar conhecimento, mas não substituir a regra versionada mais próxima.
- `#79` e `#89` exigem benchmark antes de otimizar custo/latência. O spike deve
  seguir a mesma disciplina.
- `#83` e `#87` definiram AgentRunner, routing, failover e health. Managed
  workstreams do AI Memory não devem competir com essa camada.
- `#85` fixou acceptance objetiva antes de review LLM. Conhecimento recuperado
  nunca substitui evidência.
- `#107` documentou a continuidade em um sentido Skills → CLI. AI Memory pode
  transportar contexto, mas não converte essa ponte em sincronização ou resume
  transacional.

Não foi encontrada issue aberta que represente adequadamente o spike de memória
ou os evals comportamentais das skills. Foram definidos dois follow-ups:

1. [`#110`](https://github.com/fabioassuncao/issue-flow/issues/110): spike
   arquitetural do AI Memory como fonte opcional e somente leitura;
2. [`#111`](https://github.com/fabioassuncao/issue-flow/issues/111): implementação
   incremental de evals comportamentais e reforço dos contratos das skills com os
   padrões selecionados do Superpowers.

Não foi aberta issue de worktrees/subagentes: a pesquisa multi-harness já os
classificou como evolução posterior, e esta análise não produz evidência nova
para antecipá-los.

## Critérios de decisão do spike do AI Memory

O spike só recomenda integração se todos estes pontos forem satisfeitos:

1. melhora mensurável sobre `rg` + documentação conhecida em um conjunto de
   tarefas históricas reais do Issue Flow;
2. redução ou neutralidade de tokens totais, com orçamento fixo de contexto;
3. latência aceitável e falha aberta sem afetar o pipeline;
4. zero mudança na fonte transacional e no modelo de sessões descartáveis;
5. identidade estável por project id e ausência de vazamento entre projetos;
6. proveniência suficiente para validar cada resultado;
7. operação local sem egress e sem captura automática no experimento;
8. procedimento reproduzível para conteúdo stale, incorreto e supersedido;
9. plano explícito para isolamento por issue antes de habilitar memória episódica;
10. benefício que justifique a dependência operacional e sua manutenção.

Falhar nos itens 4, 5, 6 ou 7 encerra o experimento. Ganho marginal insuficiente
nos itens 1–3 recomenda manter apenas os conceitos arquiteturais.

## Próximos passos priorizados

### P0 — spike de memória

1. selecionar 20–30 perguntas/tarefas históricas reais, incluindo decisões com
   termos diferentes dos documentos que as contêm;
2. preparar corpus somente com docs/research/decisões validadas;
3. comparar busca textual, FTS e embedding local;
4. medir `hit@k`, evidência realmente usada, qualidade final, latência e tokens;
5. testar mudança de checkout, conteúdo supersedido e projetos de mesmo nome;
6. registrar threat model mínimo e custo operacional;
7. decidir rejeição ou issue de implementação separada.

### P0 — qualidade das Agent Skills

1. definir formato de cenário, ator, verificador e métricas;
2. criar casos positivos, negativos e de pressão para skills de maior risco;
3. adicionar evidência fresca e validação de feedback aos contratos existentes;
4. testar em mais de um harness sem usar dependência da CLI;
5. manter smoke evals fora do caminho rápido do CI até medir custo e flakiness.

### P1 — somente após resultados

- extrair `KnowledgeContext` se o spike aprovar integração;
- considerar escrita por propostas com aprovação, nunca captura indiscriminada;
- avaliar um protocolo de handoff exportável sem alterar a autoridade do storage;
- considerar uma skill autocontida de debugging apenas após existir eval.

### P3 — quando paralelismo se tornar prioridade

- redesenhar lock, branch/worktree, caminhos de sessão e ownership de publicação;
- depois avaliar investigação paralela e subagentes com integração controlada;
- só então adaptar as práticas de worktree do Superpowers.

## Referências

### Issue Flow

- [README](../../README.md)
- [Skills](../skills.md)
- [Skills e agentes](../skills-and-agents.md)
- [Storage](../storage.md)
- [Agentes](../agents.md)
- [Resiliência](../resilience.md)
- [Verificação](../verification.md)
- [Orquestração multi-harness](2026-08-30-multi-harness-orchestration.md)
- [Pipeline, iterações e continuidade](2026-09-05-pipeline-iterations-corrections-continuity.md)
- [Issues do repositório](https://github.com/fabioassuncao/issue-flow/issues?q=is%3Aissue)

### AI Memory

- [Repositório e documentação](https://github.com/akitaonrails/ai-memory/tree/f830c610f7d1ee920c2e28233e26e459bb41ed06)
- [Arquitetura](https://github.com/akitaonrails/ai-memory/blob/f830c610f7d1ee920c2e28233e26e459bb41ed06/docs/ARCHITECTURE.md)
- [Handoffs e workstreams](https://github.com/akitaonrails/ai-memory/tree/f830c610f7d1ee920c2e28233e26e459bb41ed06/docs)
- [Segurança](https://github.com/akitaonrails/ai-memory/blob/f830c610f7d1ee920c2e28233e26e459bb41ed06/docs/security.md)
- [Benchmark](https://github.com/akitaonrails/ai-memory/tree/f830c610f7d1ee920c2e28233e26e459bb41ed06/docs/benchmarks)
- [Artigo AI Memory 2.0](https://akitaonrails.com/2026/09/02/ai-memory-2-0-melhor-sistema-memoria-agentes-e-times/)

### Superpowers

- [Repositório e documentação](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797)
- [Skills](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/skills)
- [Bootstrap e integrações](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/.claude-plugin)
- [Testes](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/tests)
- [Licença MIT](https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/LICENSE)
