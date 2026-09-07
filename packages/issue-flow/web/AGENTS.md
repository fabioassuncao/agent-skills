# web/ — o painel e a paleta medida que ele carrega

Esta pasta tem **um** painel.

| Onde | O quê | Servido em |
| --- | --- | --- |
| `src/` + `index.html` | Svelte 5, Tailwind 4, Vite 6, xterm.js, `diff2html`, contrato tipado. Portado do frontend do WebMux (ADR-15) **e do painel anterior** (ADR-18) | `/` |
| `src/tokens.css` | A camada de paleta: os 19 pares medidos, e a única cópia deles | `/` |

**Havia dois.** ADR-18 manteve `public/{index.html,app.js,app.css}` servido em
`/legacy/` como caminho de rollback até as três listas de §50.7 ficarem verdes.
Elas ficaram na Fase 8D, e os três arquivos saíram junto com a rota (§50.8). O
que **não** saiu foi a especificação de produto deles: as decisões medidas que
justificavam cada regra estão neste arquivo, no presente, descrevendo o painel
que existe. Se você veio procurar "o painel antigo", ele é este.

O que **sobrevive** da rota antiga: `status.json` continua sendo o fallback sem
JavaScript, servido como rota estática independente de qualquer painel, e o
`<noscript>` do `index.html` aponta para ele. E `legacy` continua em
`RESERVED_PROJECT_PREFIXES` — a rota não existe mais, então `/legacy/` responde
404, e 404 é a resposta honesta para o favorito de um painel que saiu; liberar a
palavra deixaria um projeto chamado `legacy` responder outra coisa ali.

**Quem serve.** `src/web/server.ts` lê `web/dist/` no boot: `/` é o
`index.html` do build e `/assets/<arquivo>` são os bundles com hash. Sem build
(um checkout que nunca rodou `npm run build:web`), `/` responde uma página que
diz exatamente isso e linka `status.json` — não um 404, e não mais um segundo
painel.

## Navegação unificada (§50.5)

Um modelo só. A barra lateral tem **dois grupos** — "Execuções" e "Sessões" — e
o painel principal mostra o que está selecionado. As duas palavras são os dois
termos do glossário (ADR-20) e nenhuma é sinônimo da outra: uma **execução** é
uma corrida do workflow sobre uma Task; uma **sessão** é um agente vivo num
worktree, com ou sem execução associada.

```text
/<prefixo>/
├── barra lateral: Execuções · Sessões
└── painel principal

   Task selecionada                      Sessão livre selecionada
   ├── Visão geral (fases + progresso)   ├── Terminal
   ├── Stories (lista + Kanban)          ├── Chat
   ├── Sessões e worktrees               └── Worktree e serviços
   ├── Terminal · Chat
   ├── Verificação · Review
   └── Saída · Histórico
```

**A regra que evita as duas interfaces, e o que ela significa no código:**
`ExecutionPanel.svelte` **não** decide nada a partir de "de qual lista veio a
seleção". Ele decide a partir de **uma** pergunta — existe um snapshot de
execução por trás disto? — e é isso que torna a promoção de §49.2 gratuita: uma
sessão livre vinculada a uma issue passa a ter snapshot, e as abas de workflow
aparecem no lugar, sem componente novo e sem evento.

Pelo mesmo motivo `WorkspaceBlock.svelte` é **um** componente, usado com N linhas
dentro de uma Task e com uma linha numa sessão livre. Se você se pegar criando
um segundo componente para "a versão de sessão" de algo, pare: é o sintoma de
estar reconstruindo as duas interfaces dentro de um produto só.

O terminal é a única exceção à regra "todos os painéis sempre renderizados": ele
monta ao entrar na aba. `display: none` dá ao xterm um contêiner de tamanho zero,
e um terminal que se mediu com zero colunas é pior do que um que reanexa — e
reanexar é o caminho que o porte já endureceu (`lastOffset` no quadro de attach).

---

## O painel (`src/`)

### Pipeline

Um segundo pipeline de build ao lado do `tsup` da CLI (§48.2), não um segundo
servidor: a saída é estática e quem serve continua sendo o `node:http` de
`src/web/server.ts`.

```bash
npm run dev:web      # vite, loopback, proxy para o monitor em 127.0.0.1:4318
npm run build:web    # → web/dist/
npm run test:web     # vitest com DOM (happy-dom), 20 arquivos
npm run check:web    # svelte-check
```

`vitest.config.ts` daqui é **separado** do da CLI de propósito: aquela suíte roda
em Node contra `src/**`, esta roda num DOM contra `web/src/**`, e juntá-las
faria a suíte de Node pagar por um ambiente de navegador que ela nunca usa.

### O que o `happy-dom` não mede — e a bancada que mede

`happy-dom` **não tem cascata de CSS nem layout**: `getComputedStyle` devolve
string vazia para toda custom property e `getBoundingClientRect()` devolve
zeros. Três critérios de §50.7 dependem exatamente disso — U6 ("Estado agora"
sem rolagem em 1440×900), U19 (os 19 pares de contraste **na página**) e U20
(sem rolagem horizontal em 360/768/1440).

`measure.html` + `src/measure.ts` são a bancada: montam a superfície de execução
com a mesma fixture das suítes, sem servidor e sem API, e expõem
`window.measureNowBlock()`, `window.measureHorizontalOverflow()` e
`window.measureContrastPairs(tema)`.

```bash
npm run dev:web      # e abra http://127.0.0.1:4319/measure.html
```

`measureHorizontalOverflow()` ignora um nó dentro de um **scroller próprio**
(qualquer ancestral com `overflow-x: auto|scroll`): `.if-scroll-x`, a tablist e a
grade de fases são mais largas que 360px de propósito e rolam dentro de si
mesmas. Listá-las obrigava quem lia a passar por cima da própria saída, e uma
lista que precisa ser desculpada não é uma medição. **Meça de novo sempre que o
layout mudar** — a Fase 8D trocou o conjunto de abas e os três critérios tiveram
de ser refeitos, não herdados.

Não vai para o pacote: o `vite build` tem `index.html` como única entrada, e o
`files` do `package.json` publica `web/dist`, não `web/`. As suítes
`lib/contrast.test.ts` e `lib/responsive.test.ts` são os **guardas de
regressão** dos mesmos critérios — a primeira recalcula os 19 pares a partir de
`tokens.css`/`app.css`, a segunda verifica o contrato de CSS que produz U20.

`publicDir: false` no `vite.config.ts` continua: este app não tem estáticos
próprios (as fontes e imagens vão embutidas como data URI), e um `public/` que
alguém deixasse aqui depois seria copiado para `dist/` — com um
`public/index.html` colidindo com o do build. Era exatamente assim que o painel
anterior acabava publicado duas vezes, antes de §50.8 removê-lo.

O `files` do `package.json` lista `web/dist` — nunca `web`. Com `web`, o tarball
leva `web/src/**` e o cache do Vite e **não** leva `web/dist` (o `.gitignore`
desta pasta o exclui). O `.npmignore` daqui existe só para desfazer esse
fallback. Confira com `npm pack --dry-run`.

### Contrato e capabilities

Todo request passa por `@issue-flow/contract` (`packages/issue-flow-contract`),
que é a **única** fonte de tipos: `lib/types.ts` só reexporta. O pacote irmão
tem lockfile próprio porque o `@ts-rest/core@3` tem peer em `zod@^3` enquanto a
CLI roda em `zod@4`; o Vite o resolve por alias, então nada disso chega ao
runtime da CLI. Depois de `npm ci` na CLI, rode `npm run contract:install`.

**Nunca infira uma capacidade de uma versão.** Os assets na tela podem ser mais
novos que o processo que os serve — uma execução reaproveita a instância que já
tem o lock — então `GET /api/health.capabilities` é o único sinal verdadeiro. É
a mesma regra que os dois formulários de preferência já seguiam no painel
anterior, generalizada: `canCall(rota)` decide se a superfície aparece, e uma chamada
barrada levanta `CapabilityUnavailableError`, que a interface renderiza como
"não disponível neste monitor" em vez de um 404.

Metade do contrato foi portada **antes** do backend dela. `SERVED_TODAY`, em
`contract.ts`, é a lista verificada contra `src/web/server.ts` do que existe
hoje. Ao acrescentar uma rota no backend, acrescente-a lá.

**As capacidades são granulares.** A Fase 8D separou listagem de abertura; os
blocos seguintes mantiveram a mesma regra para mutações de worktree e agentes.
Um monitor que lista sessões ou agentes não pode alegar, por isso, que sabe
integrar, arquivar, trocar profile ou persistir um template.

| Capability | O que promete | Servido por |
| --- | --- | --- |
| `sessions` | listar as sessões e os worktrees em que elas rodam | `src/web/worktrees-api.ts` |
| `session:open` | abrir, parar e vincular uma sessão (§49.3), só em loopback | `src/web/sessions-api.ts` |
| `terminal:attach` | anexar ao terminal de uma sessão, só em loopback | `src/web/terminal-ws.ts` |
| `terminal:refresh` | reanexar ao pane vivo ou retomar a mesma conversa quando morto, sem restart destrutivo | `agents/session/tabs.ts` |
| `worktrees:tabs` | criar, selecionar e encerrar forks de AgentSession no mesmo worktree | `agents/session/tabs.ts` |
| `pr:ci` | os pull requests observados e o log de uma execução de CI (§20) | `issues/github/`, via `serve.ts` |
| `worktrees:mutate` | criar, abrir/fechar, integrar, remover, arquivar, rotular, trocar profile, enviar, diff e pull-main; escrita só em loopback | `src/web/worktrees-api.ts` + `agents/session/worktree-control.ts` |
| `agents:read` | listar/validar built-ins e customs; comandos custom são redigidos fora de loopback | `src/web/agents-api.ts` |
| `agents:write` | criar, editar e remover agentes custom, só em loopback | `src/web/agents-api.ts` + `config/custom-agents.ts` |
| `linear:read` | listar tickets atribuídos; payload e erros sempre redigidos | `src/web/integrations-api.ts` + `issues/linear/` |
| `linear:write` | alternar auto-create e anexar conversa canônica ao Linear, só em loopback | `src/web/integrations-api.ts` |
| `settings:write` | alternar o GC GitHub de worktrees integrados, só em loopback | `src/web/integrations-api.ts` |

`GET /api/worktrees` é uma **projeção** de `agent_sessions`, não um segundo
registro de worktrees (§25): `executionId` de cada linha é o `runId` da sessão,
e o run id **é** o `sessionId` do dashboard. É essa igualdade — e só ela — que
faz uma Task listar seus próprios worktrees (I1) e uma sessão promovida passar a
mostrar o workflow (I4).

`TabBar` segue o mesmo modelo: `tabs[0]` é Root, o `tabId` é o id da
AgentSession e apenas forks exibem fechar. Setas, Home e End percorrem as abas;
o controle só aparece quando a linha anuncia `supportsTabs`; runtimes como
sandbox, para os quais o backend recusaria fork seguro, não exibem um “+” falso;
fechar abre confirmação em pt-BR. A barra continua visível quando o pane ativo
fica órfão para que “Retomar sessão” permaneça alcançável.

### Linear, GitHub e “Abrir no Cursor”

Existe **um** `SettingsDialog`. Linear auto-create, GitHub auto-remove,
auto-name e host SSH ocupam essa superfície; nunca crie um segundo diálogo de
integrações. O token Linear não é configuração do browser: a UI conhece apenas
`disabled | missing_api_key | ready`.

`LinearPanel`, `LinearBadge`, `LinearDetailDialog` e `LinearPostDialog` são os
quatro componentes portados. O badge liga uma branch ao ticket atribuído; o
post envia apenas o alvo e deixa o backend construir o attachment de conversa
versionado. Não aceite transcript, upload URL ou credencial vindos do DOM.

O host SSH é preferência local do navegador (`issue-flow:ssh-host`).
`makeCursorUrl()` é seu consumidor: sem host produz `cursor://file…`; com host,
`cursor://vscode-remote/ssh-remote+…`. Não existe round-trip ao servidor.

### Estado e navegação

**Não há biblioteca de estado nem router**, e isso é decisão, não omissão. O
estado global vive no `App.svelte` em runes (`$state`, `$derived`, `$effect`); a
"rota" é o **primeiro segmento do path**, que é o prefixo do projeto (§47.2), e
trocar de projeto é navegação de página inteira para `/<prefix>/`. Dois
clientes: `api` (prefixado) e `hubApi` (global). Um segmento **reservado**
(`api`, `ws`, `assets`, `health`, `legacy`) nunca vira prefixo.

### Push, não polling

`/api/stream` (Server-Sent Events) é o caminho de entrega. O intervalo de 15 s
que sobrou é rede de segurança para quando o stream cai, pausada em aba oculta
e depois de um minuto sem interação. **Não existe justificativa para voltar ao
polling de 3–8 s no caminho interativo**: §35 põe teto duro de 250 ms p95 em
output→tela.

### O terminal

`Terminal.svelte` fala com `src/web/terminal-ws.ts`. Quatro coisas são
obrigatórias e nenhuma delas é do upstream:

1. **Token na query**, obtido em `GET /api/terminal/token`, que só existe em
   loopback (ADR-10). O token é buscado por conexão, nunca cacheado: ele é
   emitido por processo, e um cacheado para de valer silenciosamente quando o
   monitor é substituído (`--restart-web`).
2. **Chave é a sessão**, não a branch (§48.3).
3. **Primeira mensagem é sempre um `resize`** — é o sinal de attach, e mandar as
   dimensões reais antes de o pty existir é o que faz o primeiro quadro já vir
   no formato certo.
4. **`lastOffset` na reconexão.** Os quadros são `o<offset>\n<dados>` e
   `s<offset>\n<dados>`; o navegador reconecta em `visibilitychange`, `focus` e
   `online`, e sem o offset trocar de aba duas vezes custa dois megabytes de
   replay.

`{type:"truncated"}` tem dois significados e os dois são ditos ao usuário:
`bytes: N` é backpressure (a saída passou a tela), `bytes: -1` é o offset pedido
ter caído fora do ring.

### A superfície de execução (`lib/Execution*`, `lib/{format,vocabulary,snapshot,executions}.ts`)

O painel atual, portado para componentes. A divisão é deliberada:

| Camada | O quê |
| --- | --- |
| `lib/format.ts` | durações, relógios e métricas. `formatUsage` **espelha** `formatTokens()` de `src/core/metrics.ts`; mudou lá, muda aqui |
| `lib/vocabulary.ts` | o glossário fechado, num lugar só. Um valor desconhecido do backend cai **dentro** do vocabulário, nunca vaza para um badge |
| `lib/snapshot.ts` | `readSnapshot()` — a leitura defensiva do `/api/status`, campo a campo. **É o guarda de U18** |
| `lib/executions.ts` | as regras puras: dashboard × detalhe, filtro de projeto, agrupamento, filtros de log e histórico |
| `lib/Execution*.svelte` | a apresentação, sem lógica de leitura |

**`readSnapshot()` é obrigatório.** O contrato tipa `/api/status` como
`Record<string, unknown>` de propósito: o `sessionSnapshotSchema` da CLI é a
autoridade, ele é versionado pela pipeline, e um monitor que recusasse um
snapshot que não entende seria pior do que um que renderiza o que reconhece. Um
componente que leia o snapshot cru repete a checagem de ausência e, mais cedo ou
mais tarde, deixa um `NaN` chegar à tela.

`undefined` ≠ `null` ≠ `0`: os dois primeiros significam "não informado" e
nenhum pode virar `0` ou `NaN`. Prefira `x !== null && x !== undefined` a `!x` —
zero é um valor legítimo. O único número com piso é `progress.percent`, porque
uma barra de progresso precisa desenhar alguma coisa.

**Uma seleção, um painel.** A sidebar tem dois grupos — `Execuções` e `Sessões`
— e o painel principal mostra o que está selecionado; nunca os dois. Escolher
uma execução limpa o worktree selecionado e vice-versa. A disponibilidade vem
de `sessions`/`session:open`; `worktrees:mutate` acrescenta a criação explícita
e seus diálogos sem mudar o caminho de um clique da sessão livre (§48.6).

**Os três painéis de aba são renderizados sempre**, não trocados. Uma aba
inativa não pode ficar defasada, e é o mesmo motivo pelo qual o drawer guarda o
`{kind,id}` e se reidrata a cada atualização em vez de congelar o que havia
quando abriu.

**A escalada de §32 é exibida, nunca decidida aqui.** `agent.awaitingInputEscalatedAt`
vem do backend (`src/core/awaiting-input.ts`), porque um run headless sem
interface nenhuma também precisa escalar (ADR-03). Ela é distinta de
`agent.humanHold`: hold é "alguém assumiu"; escalada é "ninguém veio".

### As sobreposições de §50.3, e onde cada uma foi parar

| Sobreposição | Onde ficou |
| --- | --- |
| `AgentStatusIcon` × badge de status | **`AgentStatusIcon`**, com `executionStatusToAgentStatus()` e o vocabulário fechado. `working` usa o papel `run`, não o `ok` |
| `SettingsDialog` × "Configuração efetiva" | A **leitura** fica no bloco "Contexto" (descreve a execução na tela); as **duas escritas** ficam em `PreferenceForms`, dentro do `SettingsDialog` — uma superfície de configuração no produto |
| `DiffDialog` × lista de commits | O commit abre o `DiffDialog`, onde a capability existe; sem ela, continua sendo o link para o commit |
| `PrBadge` × lista de pull requests | O `PrBadge` do WebMux, com `state: null`. O snapshot registra que um PR foi aberto e nada sobre o que houve depois — pintá-lo de "aberto" seria inventar um estado |
| toast × `#alerts` | **Os dois.** Toast = feedback de uma ação sua, some; cartão de erros = estado persistente da execução, fica |

### Detalhes que parecem ruído e não são

Cada um destes existe por uma falha específica. Ao mexer no componente, mantenha:

- **`BaseDialog`** só fecha se o *pressionar* começou no backdrop — senão
  selecionar texto e soltar fora descarta o que a pessoa estava fazendo.
- **`BranchSelector`** dá `preventDefault` no `mousedown` de cada opção: sem
  isso o foco sai do campo de busca, o `focusout` fecha o dropdown e o clique
  nunca chega na opção.
- **`WorktreeList`** mede a altura das barras de overflow para calcular o
  `rootMargin` do `IntersectionObserver`; sem isso uma linha escondida atrás da
  barra conta como visível.
- **`worktree-conversation.ts`** casa a mensagem otimista do usuário por
  `turnId`, não por id: o servidor devolve id diferente e casar por id
  duplicaria a mensagem na tela.
- **`MobileChatSurface`** mantém **um** stream por conversa, fechado só quando a
  conversa muda. Reabrir por turno faz o servidor resemear a ordenação e os
  turnos se intercalam.
- **`CommentReviewDialog`** ordena para exibir mas guarda `originalIndex` na
  seleção; ordenar a seleção junto mandaria os comentários errados na primeira
  atualização.
- **`Terminal`** bloqueia os três tipos de evento no Shift+Enter — só o
  `keydown` deixaria o `keypress` ainda emitir `\r`.
- **`ExecutionPanel`** precisa de `.if-panel[hidden] { display: none !important }`:
  o `display: grid` da regra base vence o atributo `hidden` sem isso.
- **`ExecutionDrawer`** fica em `z-index` 20/21 para cobrir o banner de
  desconexão, e fecha sozinho quando a story sai do plano em vez de mostrar um
  fantasma.
- **Card do dashboard e card do Kanban** são `<button>` com **só phrasing
  content**. `<p>` ou `<div>` dentro de um botão é HTML inválido, e o conserto do
  navegador quebra o alvo de clique.
- **`readSnapshot`** deriva `errors`/`warnings` de `logs` quando o arquivo é
  antigo demais para tê-los: eles são fatias derivadas que o reducer recalcula,
  e um `session.json` anterior a isso não os carrega.
- **A revalidação por ETag e a identidade de instância usam `fetch` direto**,
  dentro do `lib/api.ts`. O cliente tipado devolve só o corpo, e as duas coisas
  *são* cabeçalhos — `X-Issue-Flow-Instance` na resposta e o `304`, que o
  contrato deliberadamente não declara porque não tem corpo para tipar. Os
  caminhos e os tipos continuam vindo do contrato; componente nenhum chama
  `fetch`.

### Comentários em `.svelte`

Nunca escreva `<script>` ou `<style>` literais dentro de um comentário de
componente. O parser do `svelte2tsx` os lê como marcação e o `svelte-check`
falha com `` `<script>` was left open `` — numa linha que não tem nada a ver com
a causa.

---

## Paleta e tema

**As cores do Issue Flow são a fonte da verdade; o Tailwind é o mecanismo**
(ADR-19). `src/tokens.css` carrega essa paleta e, desde a Fase 8D, é a **única**
cópia dela: o guarda de deriva contra `public/app.css` saiu junto com o arquivo
que ele vigiava (§50.8). O que ele protegia continua, e mais forte —
`lib/contrast.test.ts` recalcula os 19 pares para **cada tema explícito** a
partir de `tokens.css` e `app.css`, nunca da tabela. `src/tokens.test.ts` guarda
as duas regras estruturais: nenhum token definido só dentro de um bloco de
tema, e os dois blocos escuros base carregando os mesmos overrides.

O `@theme inline` em `src/app.css` referencia os tokens; **`inline` é
obrigatório**. Sem ele o Tailwind copia a *declaração* para o próprio `:root`,
congela os valores claros e o tema escuro vira no-op — falha silenciosa que só
aparece como painel claro num sistema escuro.

**Nenhuma cor literal em classe utilitária.** Um componente novo escolhe um
papel que já existe (`bg-surface`, `text-muted`, `border-edge`, `text-danger`).
Em `<style>` com escopo, use os tokens diretamente (`var(--border)`,
`var(--accent)`): com `@theme inline` o Tailwind **não** registra `--color-*`
como custom property, e `var(--color-edge)` num estilo com escopo resolve para
nada.

As cores são **tokens nomeados por papel**, nunca por local de uso: superfície
(`--surface-page`, `--surface`, `--surface-sunken`), texto (`--text`,
`--text-muted`, `--text-subtle`), borda (`--border`, `--border-strong`), acento
(`--accent`, `--accent-text`), estado (`--state-ok|run|warn|error|merged` e o
`--state-*-surface` de cada um) e `--focus-ring`.

**Regra dura: nunca defina uma cor só dentro de um `@media` ou de um
`[data-theme]`.** `:root` carrega a paleta clara inteira; os blocos escuros
apenas redefinem o que muda. Um token que só existe num deles some no outro
tema, e o sintoma aparece longe da causa. `tokens.test.ts` verifica isso.

O tema escuro base vive em **dois blocos gêmeos** com a mesma lista de overrides:
`@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { … } }`
e `:root[data-theme='dark'] { … }`. Mexeu em um, mexa no outro — e o teste
compara os dois. O guarda `:not([data-theme='light'])` é o que faz a escolha
manual vencer o sistema nos dois sentidos. GitHub Dark, Dracula, Nord,
Solarized Dark e One Dark são blocos explícitos adicionais e completos dos
mesmos papéis. Cada escolha declara seu `color-scheme`: é ele que faz
`<select>`, `<progress>` e as barras de rolagem acompanharem o tema **efetivo**.

O tema é aplicado **antes do primeiro paint** por um `<script>` inline no
`<head>` — nos dois painéis. Ele lê `issue-flow:theme` do `localStorage` e define
`data-theme` na raiz. Fora dali o reload piscaria a paleta do SO. É à prova de
exceção (`try`/`catch`) e não referencia o bundle. Por isso a leitura da chave é
**duplicada** entre o script e o código do painel; mudou o formato do valor,
mude nos dois.

`'system'` **remove** o `data-theme` em vez de gravar `'system'`: é a ausência
do atributo que devolve a decisão ao `@media`. E o listener de
`matchMedia('(prefers-color-scheme: dark)')` fica anexado **só** no modo
`system` — com escolha explícita o SO não pode vencer. O repaint das cores é do
`@media`; o listener sincroniza o lado JS (a raiz, os seletores e a paleta do
xterm, que não é CSS).

As oito chaves aceitas são `system`, `light`, `dark`, `github-dark`, `dracula`,
`nord`, `solarized-dark` e `one-dark`. O prepaint e `themes.ts` devem mudar
juntos. Uma paleta nomeada é sempre explícita: nunca anexa o listener do SO.

Com o armazenamento bloqueado o painel carrega no modo sistema e o controle
continua alternando o tema na sessão; só não sobrevive ao reload. Todo acesso a
`localStorage` é embrulhado em `try`/`catch` (`readStored`/`writeStored`) — o
acesso **lança** num navegador configurado para bloquear dados de site.

### Contraste: os pares medidos

Os valores abaixo são calculados (WCAG 2.x, luminância relativa), não estimados
no olho. **Trocar qualquer um destes tokens exige recalcular a linha
correspondente** — a maior parte da paleta clara passa com pouca folga.

| Frente          | Fundo                    | Mínimo | Claro | Escuro |
| --------------- | ------------------------ | ------ | ----- | ------ |
| `--text`        | `--surface-page`         | 4,5:1  | 15,17 | 15,40  |
| `--text`        | `--surface`              | 4,5:1  | 16,55 | 14,04  |
| `--text`        | `--surface-sunken`       | 4,5:1  | 13,36 | 11,38  |
| `--text-muted`  | `--surface-page`         | 4,5:1  | 6,93  | 7,21   |
| `--text-muted`  | `--surface`              | 4,5:1  | 7,56  | 6,58   |
| `--text-muted`  | `--surface-sunken`       | 4,5:1  | 6,10  | 5,33   |
| `--text-subtle` | `--surface-page`         | 4,5:1  | 5,24  | 6,37   |
| `--text-subtle` | `--surface`              | 4,5:1  | 5,72  | 5,81   |
| `--text-subtle` | `--surface-sunken`       | 4,5:1  | 4,62  | 4,71   |
| `--state-ok`    | `--state-ok-surface`     | 4,5:1  | 4,57  | 8,19   |
| `--state-run`   | `--state-run-surface`    | 4,5:1  | 5,49  | 5,68   |
| `--state-warn`  | `--state-warn-surface`   | 4,5:1  | 4,51  | 8,05   |
| `--state-error` | `--state-error-surface`  | 4,5:1  | 5,30  | 5,63   |
| `--state-merged`| `--state-merged-surface` | 4,5:1  | 5,98  | 8,18   |
| `--focus-ring`  | `--surface-page`         | 3:1    | 5,76  | 6,29   |
| `--focus-ring`  | `--surface`              | 3:1    | 6,29  | 5,73   |
| `--focus-ring`  | `--surface-sunken`       | 3:1    | 5,08  | 4,65   |
| `--accent-text` | `--accent`               | 4,5:1  | 6,29  | 6,29   |
| `--accent-text` | `--state-error`          | 4,5:1  | 6,47  | 6,78   |

Os 38 valores foram **remedidos na página** na Fase 8C, com
`measureContrast(documentTokenReader())` num Chrome real sobre `measure.html`, e
conferem dígito a dígito. `lib/contrast.test.ts` é o guarda de regressão.

As cinco paletas WebMux foram medidas do mesmo modo em 2026-09-06: **95/95**
pares passaram, sem reduzir limiar. Mínimos absolutos: GitHub Dark 4,95;
Dracula 4,89 (foco, cujo mínimo é 3); Nord 4,83; Solarized Dark 4,85 (foco);
One Dark 4,74. Os 95 valores, na ordem dos pares desta tabela, ficam na ficha
[“Reversão das cinco paletas WebMux”](../../../docs/absorption-trace.md#reversão-das-cinco-paletas-webmux-pedido-do-dono-2026-09-06).

São **19 pares**: os 18 do painel atual mais `--state-merged`, o papel que o
painel precisou e a paleta não tinha. Um pull request integrado não é um
estado "ok" — pintá-lo de verde ao lado de um check verde é exatamente a
confusão que o vocabulário fechado existe para evitar.

O limiar dos badges de estado é **4,5:1 e não 3:1** porque `.badge` é
`font-size: var(--font-size-sm); font-weight: 600` — abaixo do que a WCAG chama
de texto grande. Já `--focus-ring` é componente gráfico, não texto: 3:1 basta.

No tema claro as cores de estado ficam no nível 700 da escala — é o tom mais
claro que ainda atende 4,5:1 sobre a superfície do próprio badge; `--state-ok`
(4,57) e `--state-warn` (4,51) passam por pouco. No tema escuro os preenchimentos
sólidos são claros, então `--accent-text` inverte para `#0f1218`: era branco
sobre `--state-error` no banner de desconexão, 2,98:1. **É por isso que nenhuma
classe utilitária usa `text-white`** — `text-accent-text` no lugar.

Hover e foco por teclado precisam ser **distinguíveis um do outro**. Uma única
regra `:focus-visible` desenha `outline: 2px solid var(--focus-ring)` com
`outline-offset: 2px` em todo interativo. O hover só muda cor, borda ou fundo —
nunca o anel. Inclusive num elemento que já tem `border-color` própria: o foco
precisa do outline, não de outra troca de borda.

Para medir contraste, **meça na página** (ler os tokens com
`getComputedStyle(document.documentElement)` e calcular a razão em JS), nunca a
partir dos valores no arquivo: só assim a cascata resolvida aparece, incluindo o
token que um tema herda do outro por engano.

---

## Escalas de tipografia, espaçamento e raio

Ao lado das cores, `:root` declara três escalas **fechadas**. Um componente novo
escolhe um degrau que já existe; não introduz um valor local.

| Escala | Tokens |
| --- | --- |
| Tipografia | `--font-size-xs` 0.75rem · `sm` 0.8125 · `md` 0.875 · `base` 0.9375 · `lg` 1 · `xl` 1.25 |
| Espaçamento | `--space-4` · `--space-8` · `--space-12` · `--space-16` · `--space-24` |
| Raio | `--radius-small` 6px · `--radius-medium` 10px · `--radius-pill` 999px |

`--font-size-base` é o tamanho do `body`; `xl` é o `h1` e `lg` o `h2`. O
espaçamento cobre `gap`, `padding` e `margin`. Raio: `medium` para superfícies
com cara de cartão, `small` para linhas, controles e caixas internas, `pill`
para badges, trilhas de progresso e pontos — inclusive no lugar de
`border-radius: 50%`.

**Três exceções, e só elas**, cada uma com comentário ao lado: o
`margin-bottom: -1px` das abas (compensa a borda, é alinhamento), o `gap: 1px`
da grade de fases (o fundo `--border` vazando pelo gap é a linha divisória) e o
`calc(var(--space-8) - 2px)` das linhas com `box-shadow` interna, que desconta a
sombra para preservar o ritmo — `.if-story-executing`, e a linha selecionada de
`WorkspaceBlock`, que é a mesma exceção aplicada ao mesmo problema. Um valor
solto sem um motivo dessa ordem é dívida — troque pelo degrau. Múltiplos são
`calc()` sobre um token, não um sexto token.

As escalas entram por duas vias: `<style>` com escopo usa os
tokens direto (`var(--space-12)`, `var(--radius-medium)`); as classes utilitárias
do Tailwind vieram do porte e ainda carregam degraus próprios em alguns
componentes. Convergir as duas é trabalho da Fase 8D (§50.4), não deste porte —
o que **não** se admite desde já é cor literal.

---

## Glossário

Termos da interface — um por conceito, em tudo que é visível ao usuário nos dois
painéis. Comentários de código podem falar a língua do domínio; a tela não.

| Conceito | Termo na UI | Não usar |
| --- | --- | --- |
| Uma corrida do pipeline sobre uma Task | **execução** / **execuções** | sessão |
| Um agente vivo num worktree, com ou sem execução | **sessão** / **sessões** | execução |
| Item do plano | **user story** / **user stories** | story, stories, User Story misturado |
| Estado da corrida ou do agente | **aguardando / executando / concluído / falhou** | sinônimos soltos no badge |
| Indicador de corrida ativa | **ao vivo** + `.live` | "live", segundo badge, ponto com uppercase |
| Integrar uma branch | **integrar** | merge, mergear |
| Trazer o remoto | **atualizar** | pull, puxar |
| Pull request em rascunho | **rascunho** | draft |
| Pull request integrado | **integrado** | merged |

**A linha de "sessão" é nova e é a colisão resolvida em §50.4.** Sessão passou a
ser conceito real de primeira classe (ADR-16/§49): os dois termos coexistem com
significados distintos e documentados, e "execução" **nunca** vira sinônimo de
"sessão". `AgentStatusIcon` aplica o vocabulário fechado (`agentStatusLabel`), e
um status desconhecido do backend cai dentro do vocabulário em vez de vazar
para um badge.

Travessão (`—`) fica só em placeholders de valor ausente (`#—`, timers). Em
frase, use ponto ou vírgula: "Desconectado do servidor. Tentando reconectar…",
"Execução falhou. Veja os erros acima."

---

## O contrato de produto, herdado do painel anterior

`public/{index.html,app.js,app.css}` saiu na Fase 8D (§50.8), depois das três
listas de §50.7 verdes. **As decisões dele não saíram junto** — são as regras
abaixo, e todas descrevem o painel que existe hoje. Cada uma foi medida ou
aprendida uma vez; nenhuma é preferência.

### Contrato de dados

O painel consome `GET api/sessions` (lista enriquecida para o dashboard),
`GET api/status` (o `SessionSnapshot` serializado, opcionalmente com
`?session=<id>`), `GET api/events?session=<id>` (journal) e `GET api/health`.
Ele precisa renderizar **session.json de execuções antigas**, então todo campo
pode chegar como `undefined` (não existia na versão que gravou o arquivo) além
do `null` (existe, não informado). Os dois significam "não informado" e nunca
podem virar `0`, `NaN` ou `undefined` na tela — daí o helper `metric()`, que
normaliza qualquer coisa que não seja número finito para `null`. Prefira
`x !== null && x !== undefined` a `!x`: zero é um valor legítimo.

O chip de versão no header é a versão do **monitor** (`/api/health`), não a da
CLI que executa o pipeline: os assets desta página vêm da memória daquele
processo. As duas aparecem juntas no card de configuração, e a divergência entre
elas vira um aviso ali.

Toda resposta nova carrega `X-Issue-Flow-Instance`. O client guarda a primeira
identidade observada e chama `window.location.reload()` quando ela muda: isso é
o handoff de assets depois de `--restart-web`, não um estado de sessão.

### Vários projetos

O painel também consome `GET api/projects`, que lista os projetos que o servidor
conhece — **inclusive os que não têm execução nenhuma**. Com mais de um projeto
conhecido, `renderDashboard()` troca a grade de cards por um bloco por projeto
(a visão "Trabalho ativo"); o seletor ao lado do controle de atualização filtra
para um projeto só.

Duas regras seguram isso:

- **Com um projeto (ou nenhum) o comportamento é exatamente o de antes.** O
  seletor nem aparece: seria um controle com uma opção só.
- **A escolha do projeto é preferência de visualização**, guardada em
  `localStorage` como o tema e o intervalo. O registry é a autoridade sobre
  quais projetos existem, nunca sobre qual deles alguém está olhando. Um projeto
  que sai da curadoria com o filtro apontando para ele volta o painel para
  "todos", em vez de deixar a tela vazia sem explicação.

Uma sessão cujo `projectId` o registry não conhece continua visível, agrupada em
"Outros projetos": o mundo externo é autoridade sobre o que existe.

Com **uma** sessão ativa e um único projeto o painel abre direto no detalhe. Com
**duas ou mais**, `renderDashboard()` lista um card por execução; o clique define
`state.selectedSessionId` e o poll passa a usar o `statusUrl` daquela sessão.
`selectedSessionId === null` é o modo automático. Trocas de sessão (e o modo
dashboard) zeram `snapshot`/`etag` via `detailSessionId` para não pintar dados da
execução anterior. Clique durante um poll em andamento marca `pollAgain` em vez
de ser descartado.

Os cards do dashboard são `<button>` como os do Kanban: só *phrasing content*
(`<span>`), nunca `<div>`/`<p>` dentro do botão. `issueDescription` em
`/api/sessions` já vem truncada no servidor; o client ainda aplica
`truncateText` na renderização.

Texto dinâmico sempre via `textContent`/`el()`; nunca `innerHTML` com dados do
snapshot.

### Abas, Kanban e drawer

O conjunto de abas é o de §50.5 (acima); eram três no painel anterior
("Execução", "Kanban", "Histórico"). O que não mudou é o **padrão ARIA de
tablist**: setas ←/→ movem o foco, Home/End vão às pontas, e só a aba ativa tem
`tabindex="0"` (as demais `-1`). Um único drawer serve fases e stories. Três
regras seguram esse conjunto:

- **Acesso a story sempre por `getStoryById()` / `getStories()`.** Elas
  normalizam num lugar só o que pode faltar num `session.json` antigo (`status` →
  `'backlog'`, `dependencies`/`acceptanceCriteria` → `[]`, `description` → `''`)
  e são o ponto onde uma futura camada de escrita entra.
- **Estado de UI vive em `state`** (`activeTab`, `selectedDetail`, `logFilter`),
  nunca em variável solta ou em referência a nó do DOM. O drawer guarda o **id**
  da story, não o card: `render()` recria o Kanban a cada poll, então uma
  referência guardada na abertura apontaria para um nó fora do documento. Pelo
  mesmo motivo o foco volta ao card via `[data-story-id="…"]` ao fechar.
- **Todos os painéis são renderizados**, não trocados: uma aba inativa não pode
  ficar defasada, e é a reidratação do drawer a cada atualização que o mantém em
  dia (e o fecha quando a story some do plano). A única exceção é o terminal,
  pela razão de layout registrada em §50.5 acima.

Cada card do Kanban é um `<button>` — Enter/Espaço e foco saem de graça. Como
`<button>` só aceita *phrasing content*, todo o conteúdo interno é `<span>` com
`display: block`/`flex` no CSS.

Detalhes cosméticos que não são cosméticos: `.tab-panel[hidden]` e
`.drawer[hidden]` precisam de `display: none` explícito, senão o `display:
grid`/`flex` da regra base vence o atributo `hidden`. E o overlay/drawer ficam em
`z-index` 20/21 para cobrir o `.banner` de desconexão, que é `sticky` com
`z-index: 10`.

### Header: informação, não marca

O `h1` das duas views **não** carrega o nome do produto — a marca vive só no
`<title>` do documento, no formato `<contexto> · issue-flow`. No detalhe o `h1` é
a execução (`#N` como link para a issue, seguido do título dela) — ou, numa
sessão livre, o rótulo dela e sua branch, pelo **mesmo** `ExecutionHeader`; no
dashboard é "Trabalho ativo". Não devolva "issue-flow" para dentro do `h1`: a
linha mais visível da tela é para o que está acontecendo. `TopBar.test.ts` e
`ExecutionPanel.test.ts` defendem a regra.

O resto da identidade fica ao redor do `h1`: branch e chip de versão na
`.header-meta`, status, tempo decorrido e estimativa no `.header-side`. O título
da issue aparece **uma vez só**.

Layout: `.header-main` é `flex: 1 1 320px` e o `.header-side` fica com o `flex`
padrão (`0 1 auto`). O `.header-side` **precisa** poder encolher — os timers são
largos e, fixados em `flex: 0 0 auto`, estouram a largura em 360px. O `h1` é
fluxo inline (não flex), senão um título longo empurra o `#N` para uma linha
sozinha.

### Blocos da aba Execução

Os quatro cartões seguem existindo, e a ordem continua sendo a hierarquia. §50.5
os distribuiu por abas em vez de empilhar os quatro numa só:

| Bloco | O que carrega | Aba |
| --- | --- | --- |
| Estado agora | progresso, "Executando agora", "Resiliência" e a linha "Próximos passos" | Visão geral |
| Contexto | issue, repositório e "Harnesses e configuração efetiva" | Visão geral |
| Andamento | fases · user stories | Visão geral · Stories |
| Saída | commits, pull requests e logs recentes | Saída |

`ProgressBlock` recebe `part` (`'phases'`/`'stories'`/`'both'`) em vez de virar
dois componentes: dois arquivos quase iguais é como uma lista de fases e uma de
stories começam a discordar sobre o que é uma linha.

Cada assunto dentro de um bloco é uma `.block-part` com `<h3>` — **sem borda,
sem fundo, sem sombra própria**: quem separa é o `gap` do grid de `.block`.
Assunto novo entra como `.block-part` de um bloco existente; um cartão novo só
se justifica se não couber em nenhum dos quatro. Foi a proliferação de cartões de
mesmo peso (doze deles) que a issue #98 desfez, e ela volta sozinha se cada
mudança acrescentar "só mais um".

"Estado agora" é o único bloco com um requisito de layout: precisa caber sem
rolagem em 1440x900 **com o cartão de erros e avisos aberto**. Antes de
acrescentar linha ali, meça (`getBoundingClientRect().bottom <= innerHeight`).

A partir de 960px o `#panel-execution` vira um grid de duas colunas. Os dois
breakpoints são 640px e 960px — um componente novo se encaixa nesses, não
inventa o terceiro. `main` tem `max-width: 1200px`. Sem rolagem horizontal em
360, 768 e 1440.

"Contexto" roda um degrau abaixo (`--font-size-md` no bloco todo): é referência,
não estado. "Próximos passos" é uma linha só, e o rótulo vem do HTML.

### Escrita limitada a preferências

O estado de execução continua somente leitura (`snapshot.readOnly === true`). As
únicas mutações são `POST /api/config/agent` e `POST /api/config/routing`, que
salvam preferências globais para execuções **futuras**, aparecem via capability e
só funcionam em loopback. **Nunca inferir permissão pela versão**: o client
renderiza os formulários apenas quando `/api/health.capabilities` anuncia as duas
capacidades. Cada mutação responde com
`{ ok, file, appliesTo: 'future executions' }`.

### Métricas (tokens e custo)

`formatUsage()` espelha `formatTokens()` de `src/core/metrics.ts` — mesma ordem
de segmentos (`in / out · cache · ~$`) e mesma compactação (`1.5k`/`2.4M`).
Divergência proposital: o custo usa 2 casas decimais (4 abaixo de um centavo),
porque o painel prioriza leitura rápida enquanto o terminal mostra precisão
cheia. Se `metrics.ts` mudar de formato, atualize os dois.

O agregado da issue vem de `snapshot.metrics` (chaves `total*`), a fase e a story
têm os campos direto no objeto. Duração e métricas compartilham o slot
`.item-side`, unidos por `' · '` via `itemSideText()`, que descarta as partes
vazias — string vazia é o sinal de "não renderizar".

---

## Como verificar uma mudança

### Testes e tipos

`npm run test:web` e `npm run check:web` cobrem lógica, marcação e tipos. O que
eles não cobrem é a tela: para isso, `npm run dev:web` com o monitor no ar.

### Com dados de verdade

Teste e typecheck não cobrem a tela. Para isso, sirva o servidor real de um
`ISSUE_FLOW_HOME` descartável:

1. Escreva um ou mais `session.json` (o schema é `sessionSnapshotSchema` em
   `src/schemas.ts`) em `<home>/projects/<projeto>/issues/<n>/session.json`, com
   `events.jsonl` ao lado no formato `{ seq, event }` da aba Histórico. **Duas**
   sessões abrem o dashboard; uma só abre direto no detalhe.
2. `npm run build` e `ISSUE_FLOW_HOME=<home> node dist/cli.js web serve --port
   <p> --host 127.0.0.1`. O servidor lê `web/dist/`, então uma edição em `src/`
   exige `npm run build:web` antes do restart. Para iterar, prefira
   `npm run dev:web` com o monitor no ar.
3. Uma sessão some após **90s** sem heartbeat: `touch` periódico no
   `session.json` a mantém viva pelo tempo da verificação.

Os estados que só aparecem sob condição se forçam do console: o `.banner` de
desconexão, substituindo `window.fetch` por um que rejeita (e restaurando
depois); o armazenamento bloqueado, com um `Object.defineProperty(window,
'localStorage', { get() { throw … } })` num script de inicialização; a troca de
tema do SO, pela emulação de `prefers-color-scheme` do DevTools, que dispara o
evento `change` real da media query.

### CSP

`baseHeaders()` em `src/web/server.ts` hoje não define
`Content-Security-Policy`. Se um CSP for adicionado, ele precisa contemplar o
script inline de tema do `index.html` (`'unsafe-inline'` em `script-src` ou,
melhor, um hash/nonce), senão o painel volta a piscar — e um `script-src`
estrito sem essa provisão quebra a aplicação do tema silenciosamente.
