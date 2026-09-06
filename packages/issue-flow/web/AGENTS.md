# web/public — painel de monitoramento

Três arquivos estáticos servidos por `src/web/server.ts` (que os lê de
`web/public` tanto rodando de `src/` quanto do `dist/` publicado). São
assets do pacote: entram no `files` do package.json e **não** passam por
build, typecheck, biome (`files.includes` cobre só `src/**/*.ts`) nem
vitest. Toda verificação de mudança aqui é manual, no navegador.

## Contrato de dados

O painel consome `GET api/sessions` (lista enriquecida para o dashboard),
`GET api/status` (o `SessionSnapshot` serializado, opcionalmente com
`?session=<id>`), `GET api/events?session=<id>` (journal) e `GET api/health`. Ele precisa renderizar **session.json de
execuções antigas**, então todo campo pode chegar como `undefined` (não
existia na versão que gravou o arquivo) além do `null` (existe, não
informado). Os dois significam "não informado" e nunca podem virar `0`,
`NaN` ou `undefined` na tela — daí o helper `metric()`, que normaliza
qualquer coisa que não seja número finito para `null`. Prefira
`x !== null && x !== undefined` a `!x`: zero é um valor legítimo.

O chip de versão no header é a versão do **monitor** (`/api/health`), não a da
CLI que executa o pipeline: os assets desta página vêm da memória daquele
processo, então é ela que explica o que está na tela. As duas aparecem juntas no
card de configuração, e a divergência entre elas vira um aviso ali.

Toda resposta nova carrega `X-Issue-Flow-Instance`. O client guarda a primeira
identidade observada e chama `window.location.reload()` quando ela muda: isso é
o handoff de assets depois de `--restart-web`, não um estado de sessão.

## Vários projetos

O painel também consome `GET api/projects`, que lista os projetos que o
servidor conhece — **inclusive os que não têm execução nenhuma**, que é o caso
que antes não existia. Com mais de um projeto conhecido, `renderDashboard()`
troca a grade de cards por um bloco por projeto (a visão "Trabalho ativo"), cada
um com as suas execuções ou com a afirmação explícita de que não há nenhuma; o
seletor ao lado do controle de atualização filtra para um projeto só.

Duas regras seguram isso:

- **Com um projeto (ou nenhum) o comportamento é exatamente o de antes.** O
  seletor nem aparece: seria um controle com uma opção só.
- **A escolha do projeto é preferência de visualização**, guardada em
  `localStorage` como o tema e o intervalo. O registry é a autoridade sobre
  quais projetos existem, nunca sobre qual deles alguém está olhando. Um
  projeto que sai da curadoria com o filtro apontando para ele volta o painel
  para "todos", em vez de deixar a tela vazia sem explicação.

Uma sessão cujo `projectId` o registry não conhece continua visível, agrupada
em "Outros projetos": o mundo externo é autoridade sobre o que existe.

Com **uma** sessão ativa e um único projeto o painel abre direto no detalhe
(comportamento histórico). Com **duas ou mais**, `renderDashboard()` lista um
card por execução; o clique define `state.selectedSessionId` e o poll passa a usar o
`statusUrl` daquela sessão. `selectedSessionId === null` é o modo automático.
Trocas de sessão (e o modo dashboard) zeram `snapshot`/`etag` via
`detailSessionId` para não pintar dados da execução anterior. Clique durante
um poll em andamento marca `pollAgain` em vez de ser descartado.

Os cards do dashboard são `<button>` como os do Kanban: só *phrasing content*
(`<span>`), nunca `<div>`/`<p>` dentro do botão. `issueDescription` em
`/api/sessions` já vem truncada no servidor (preview); o client ainda aplica
`truncateText` na renderização.

Texto dinâmico sempre via `textContent`/`el()`; nunca `innerHTML` com dados
do snapshot.

## Abas, Kanban e drawer

O painel tem três abas ("Execução", "Kanban" e "Histórico") e um único drawer de detalhes
para fases e stories (inclusive cards do Kanban). As abas seguem o padrão ARIA de
tablist: setas ←/→ movem o foco, Home/End vão às pontas, e só a aba ativa tem
`tabindex="0"` (as demais `-1`). Três regras seguram esse conjunto:

- **Acesso a story sempre por `getStoryById()` / `getStories()`.** Elas são a
  camada de leitura: normalizam num lugar só o que pode faltar num
  `session.json` antigo (`status` → `'backlog'`, `dependencies`/
  `acceptanceCriteria` → `[]`, `description` → `''`) e são o ponto onde uma
  futura camada de escrita entra. Nenhum consumidor varre `snapshot.stories`
  por conta própria, ou a normalização se espalha.
- **Estado de UI vive em `state`** (`activeTab`, `selectedDetail`), junto de
  `logFilter`, nunca em variável solta ou em referência a nó do DOM. O drawer
  guarda o **id** da story, não o card: `render()` recria o Kanban a cada poll,
  então uma referência guardada na abertura apontaria para um nó fora do
  documento. Pelo mesmo motivo o foco volta ao card via
  `[data-story-id="…"]` no momento de fechar.
- **`renderKanban()`, `renderHistory()` e `renderDrawer()` são chamadas incondicionalmente** dentro
  de `render()`, não ao trocar de aba. Uma aba inativa não pode ficar defasada,
  e é o `renderDrawer()` de cada poll que mantém o drawer aberto em dia (e o
  fecha quando a story some do plano).

Cada card do Kanban é um `<button>` — Enter/Espaço e foco saem de graça. Como
`<button>` só aceita *phrasing content*, todo o conteúdo interno é `<span>` com
`display: block`/`flex` no CSS; `<p>` ou `<div>` ali dentro é HTML inválido.

Detalhes cosméticos que não são cosméticos: `.tab-panel[hidden]` e
`.drawer[hidden]` precisam de `display: none` explícito, senão o `display:
grid`/`flex` da regra base vence o atributo `hidden`. E o overlay/drawer ficam
em `z-index` 20/21 para cobrir o `.banner` de desconexão, que é `sticky` com
`z-index: 10`.

## Header: informação, não marca

O `h1` das duas views **não** carrega o nome do produto — a marca vive só no
`<title>` do documento, que `renderTitle()`/`renderDashboard()` mantêm no
formato `<contexto> · issue-flow`. No detalhe o `h1` é a execução (`#N` como
link para a issue, seguido do título dela); no dashboard é "Execuções ativas".
Não devolva "issue-flow" para dentro do `h1`: a linha mais visível da tela é
para o que está acontecendo.

O resto da identidade da execução fica ao redor do `h1`: branch e chip de
versão na `.header-meta` logo abaixo, status, tempo decorrido e estimativa no
`.header-side`. O título da issue aparece **uma vez só** — por isso
`renderIssueSummary()` não repete número nem título no bloco "Contexto",
deixando ali estado, labels e descrição.

Layout: `.header-main` é `flex: 1 1 320px` e o `.header-side` fica com o
`flex` padrão (`0 1 auto`). O `.header-side` **precisa** poder encolher — os
timers são largos e, fixados em `flex: 0 0 auto`, estouram a largura em 360px.
O `h1` é fluxo inline (não flex), senão um título longo empurra o `#N` para
uma linha sozinha.

## Blocos da aba Execução

A aba "Execução" tem **quatro** cartões, nesta ordem, e a ordem é a hierarquia:

| Bloco | O que carrega |
| --- | --- |
| Estado agora | progresso, "Executando agora", "Resiliência" e a linha "Próximos passos" |
| Contexto | issue, repositório e "Harnesses e configuração efetiva" |
| Andamento | fases e user stories |
| Saída | commits, pull requests e logs recentes |

Cada assunto dentro de um bloco é uma `.block-part` com `<h3>` — **sem borda,
sem fundo, sem sombra própria**: quem separa é o `gap` do grid de `.block`.
Assunto novo entra como `.block-part` de um bloco existente; um cartão novo na
aba só se justifica se não couber em nenhum dos quatro. Foi a proliferação de
cartões de mesmo peso (doze deles) que a issue #98 desfez, e ela volta sozinha
se cada mudança acrescentar "só mais um".

"Estado agora" é o único bloco com um requisito de layout: precisa caber sem
rolagem em 1440x900 **com o cartão de erros e avisos aberto**. Antes de
acrescentar linha ali, meça (`getBoundingClientRect().bottom <= innerHeight`).

A partir de 960px o `#panel-execution` vira um grid de duas colunas: Contexto
fica ao lado de Estado agora / Andamento, e Saída ocupa a largura toda. Os
dois breakpoints do painel são 640px (estreito) e 960px (largo) — um
componente novo se encaixa nesses, não inventa o terceiro. `main` tem
`max-width: 1200px`. Sem rolagem horizontal em 360, 768 e 1440.

"Contexto" roda um degrau abaixo (`--font-size-md` em todo o bloco): é
referência, não estado. "Próximos passos" é uma linha só — `renderNextSteps()`
junta os passos com `·` num `<span>`, e o rótulo vem do HTML
(`.next-steps-label`), não do JS.

## Glossário

Termos da interface — um por conceito, em todo `index.html` e `app.js` visível
ao usuário. Comentários de código podem falar a língua do domínio (`session`,
`story`); a tela não.

| Conceito | Termo na UI | Não usar |
| --- | --- | --- |
| Uma corrida do pipeline | **execução** / **execuções** | sessão (exceto no identificador técnico, e mesmo aí o rótulo é "execução `<id>`") |
| Item do plano | **user story** / **user stories** | story, stories, User Story misturado |
| Estado da corrida | **aguardando / executando / concluído / falhou** | sinônimos soltos no badge |
| Indicador de corrida ativa | **ao vivo** + `.live` | "live", segundo badge, ponto com uppercase |

Travessão (`—`) fica só em placeholders de valor ausente (`#—`, timers). Em
frase, use ponto ou vírgula: "Desconectado do servidor. Tentando reconectar…",
"Execução falhou. Veja os erros acima."

O título do drawer é o da user story (`US-00N · título`) ou `Fase · <nome>`,
nunca "Detalhes da user story".

## Escalas de tipografia, espaçamento e raio

Ao lado das cores, `:root` declara três escalas **fechadas**. Um componente
novo escolhe um degrau que já existe; não introduz um valor local.

| Escala | Tokens |
| --- | --- |
| Tipografia | `--font-size-xs` 0.75rem · `sm` 0.8125 · `md` 0.875 · `base` 0.9375 · `lg` 1 · `xl` 1.25 |
| Espaçamento | `--space-4` · `--space-8` · `--space-12` · `--space-16` · `--space-24` |
| Raio | `--radius-small` 6px · `--radius-medium` 10px · `--radius-pill` 999px |

`--font-size-base` é o tamanho do `body`; `xl` é o `h1` e `lg` o `h2`. O
espaçamento cobre `gap`, `padding` e `margin` — os quatro valores de rem que
existiam (`0.65rem`, `0.75rem`, `0.8rem`, `1rem`) foram arredondados para o
degrau mais próximo, e é isso que se faz com qualquer valor novo. Raio:
`medium` para superfícies com cara de cartão (`.card`, `.kanban-card`,
`.kanban-column`, `.execution-entry`), `small` para linhas, controles e caixas
internas, `pill` para badges, trilhas de progresso e pontos — inclusive no
lugar do antigo `border-radius: 50%`.

**Três exceções, e só elas**, cada uma com comentário no `app.css`: o
`margin-bottom: -1px` das abas (compensa a borda, é alinhamento), o `gap: 1px`
de `.config-phase-grid` (o fundo `--border` vazando pelo gap é a linha
divisória) e o `calc(var(--space-12) - 3px)` de `.story-executing` (desconta a
`box-shadow` interna para preservar o ritmo). Um valor solto sem um motivo
dessa ordem é dívida — troque pelo degrau.

Múltiplos são escritos como `calc()` sobre um token (`calc(var(--space-24) *
2)` no rodapé do `main`), não como um sexto token de espaçamento.

## Paleta e tema

As cores do `app.css` são **tokens nomeados por papel**, não por local de uso:
superfície (`--surface-page`, `--surface`, `--surface-sunken`), texto (`--text`,
`--text-muted`, `--text-subtle`), borda (`--border`, `--border-strong`), acento
(`--accent`, `--accent-text`), estado (`--state-ok|run|warn|error` e o
`--state-*-surface` que acompanha cada um) e `--focus-ring`. Um componente novo
escolhe o papel que já existe em vez de inventar uma cor.

**Regra dura: nunca defina uma cor só dentro de um `@media` ou de um
`[data-theme]`.** `:root` carrega a paleta clara inteira; os blocos escuros
apenas redefinem o que muda. Um token que só existe num deles some no outro
tema, e o sintoma aparece longe da causa.

O tema escuro vive em **dois blocos gêmeos** com a mesma lista de overrides:
`@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { … } }`
e `:root[data-theme='dark'] { … }`. Mexeu em um, mexa no outro. O guarda
`:not([data-theme='light'])` é o que faz a escolha manual vencer o sistema nos
dois sentidos. Cada bloco declara seu próprio `color-scheme` (e `:root`, o
`light`): é ele — não um `<meta name="color-scheme">`, que foi removido do
`index.html` justamente por isso — que faz `<select>`, `<progress>` e as barras
de rolagem acompanharem o tema **efetivo** em vez do tema do SO.

O antigo `--idle-bg` (badge inerte, contagem de coluna do Kanban, hover do
fechar do drawer, trilha da barra de progresso) virou **`--surface-sunken`**, e
não um `--state-neutral-surface`: metade dos usos não é badge de estado, e um
recesso neutro é a mesma coisa nos dois casos. "Sem estado" não é um estado.

O tema é aplicado **antes do primeiro paint** por um `<script>` inline no
`<head>` do `index.html`, colocado antes do `<link>` do `app.css`: ele lê
`issue-flow:theme` do `localStorage` e define `data-theme` na raiz. Fora dali
o reload piscaria a paleta do SO até o `app.js` rodar. Ele é à prova de
exceção (`try`/`catch`) e não referencia nada do `app.js` — que só carrega no
fim do `<body>`. Por isso a leitura da chave é **duplicada** entre os dois, com
comentário nos dois lugares; mudou o formato do valor, mude nos dois.

O controle do tema é um `<select>` de três opções (Sistema/Claro/Escuro)
**duplicado nos dois headers** (`theme-select` e `theme-select-dashboard`),
como já acontece com o de intervalo — mudar num reflete no outro via
`syncThemeSelects()`. As opções são estáticas no HTML (ao contrário de
`fillRefreshSelect`, que monta as suas); o JS só sincroniza `.value`. A
preferência vive em `state.theme`, nunca em variável solta, e `'system'`
**remove** o `data-theme` da raiz em vez de gravar `'system'`: é a ausência do
atributo que devolve a decisão ao `@media`.

A escolha é persistida em `issue-flow:theme` (`'system' | 'light' | 'dark'`)
por `readStoredTheme()` / `storeTheme()`, que copiam a forma de
`readStoredRefresh()` / `storeRefresh()`: leitura e escrita em `try`/`catch`,
valor ausente ou desconhecido caindo para `'system'`, e **nenhum wrapper
genérico de storage** — duas chaves não justificam uma abstração. Com o
armazenamento bloqueado o painel carrega no modo sistema e o `<select>`
continua alternando o tema na sessão; só não sobrevive ao reload.

No modo `'system'` — e **só** nele — um listener de
`matchMedia('(prefers-color-scheme: dark)')` fica anexado, para a troca de tema
do SO chegar ao painel sem reload; `setTheme()` o desanexa quando a escolha
passa a ser forçada e o reanexa quando volta a `'system'`. O repaint das cores
em si é do `@media`, que o navegador reavalia sozinho: o listener sincroniza o
lado JS (raiz e o `.value` dos seletores).

Consequência para o servidor: `baseHeaders()` em `src/web/server.ts` hoje não
define `Content-Security-Policy`. Se um CSP for adicionado, ele precisa
contemplar esse script inline (`'unsafe-inline'` em `script-src` ou, melhor, um
hash/nonce), senão o painel volta a piscar — e um `script-src` estrito sem essa
provisão quebra a aplicação do tema silenciosamente.

### Contraste: os pares medidos

Os valores abaixo são calculados (WCAG 2.x, luminância relativa), não estimados
no olho. **Trocar qualquer um destes tokens exige recalcular a linha
correspondente** — a maior parte da paleta clara passa com pouca folga.

| Frente          | Fundo                   | Mínimo | Claro | Escuro |
| --------------- | ----------------------- | ------ | ----- | ------ |
| `--text`        | `--surface-page`        | 4,5:1  | 15,17 | 15,40  |
| `--text`        | `--surface`             | 4,5:1  | 16,55 | 14,04  |
| `--text`        | `--surface-sunken`      | 4,5:1  | 13,36 | 11,38  |
| `--text-muted`  | `--surface-page`        | 4,5:1  | 6,93  | 7,21   |
| `--text-muted`  | `--surface`             | 4,5:1  | 7,56  | 6,58   |
| `--text-muted`  | `--surface-sunken`      | 4,5:1  | 6,10  | 5,33   |
| `--text-subtle` | `--surface-page`        | 4,5:1  | 5,24  | 6,37   |
| `--text-subtle` | `--surface`             | 4,5:1  | 5,72  | 5,81   |
| `--text-subtle` | `--surface-sunken`      | 4,5:1  | 4,62  | 4,71   |
| `--state-ok`    | `--state-ok-surface`    | 4,5:1  | 4,57  | 8,19   |
| `--state-run`   | `--state-run-surface`   | 4,5:1  | 5,49  | 5,68   |
| `--state-warn`  | `--state-warn-surface`  | 4,5:1  | 4,51  | 8,05   |
| `--state-error` | `--state-error-surface` | 4,5:1  | 5,30  | 5,63   |
| `--focus-ring`  | `--surface-page`        | 3:1    | 5,76  | 6,29   |
| `--focus-ring`  | `--surface`             | 3:1    | 6,29  | 5,73   |
| `--focus-ring`  | `--surface-sunken`      | 3:1    | 5,08  | 4,65   |
| `--accent-text` | `--accent`              | 4,5:1  | 6,29  | 6,29   |
| `--accent-text` | `--state-error`         | 4,5:1  | 6,47  | 6,78   |

O limiar dos badges de estado é **4,5:1 e não 3:1** porque `.badge` é
`font-size: var(--font-size-sm); font-weight: 600` — abaixo do que a WCAG chama de texto
grande. Já `--focus-ring` é um componente gráfico, não texto: 3:1 basta.

No tema claro as quatro cores de estado ficam no nível 700 da escala — é o tom
mais claro que ainda atende 4,5:1 sobre a superfície do próprio badge; `--state-ok`
(4,57) e `--state-warn` (4,51) passam por pouco. No tema escuro os
preenchimentos sólidos são claros, então `--accent-text` inverte para
`#0f1218`: era branco sobre `--state-error` no banner de desconexão, 2,98:1.

Hover e foco por teclado precisam ser **distinguíveis um do outro**. Uma
única regra `:focus-visible` compartilhada desenha `outline: 2px solid
var(--focus-ring)` com `outline-offset: 2px` em todo interativo (abas, cards
do dashboard e do Kanban, `<select>`s, fechar do drawer, "Todas as execuções",
linhas de fase/story). O hover só muda cor, borda ou fundo — nunca o anel.
Inclusive em `.dashboard-card.is-live`, que já tem `border-color` própria: o
foco precisa do outline, não de outra troca de borda.

## Como verificar uma mudança aqui

Nada nesta pasta é coberto por teste automatizado, então a verificação é um
navegador com **dados de verdade**. `python3 -m http.server` dentro de
`web/public/` basta para inspecionar o CSS, mas o painel fica no estado
desconectado — não dá para exercitar alertas, Kanban, drawer nem métricas.

Para isso, sirva o servidor real de um `ISSUE_FLOW_HOME` descartável:

1. Escreva um ou mais `session.json` (o schema é `sessionSnapshotSchema` em
   `src/schemas.ts`) em `<home>/projects/<projeto>/issues/<n>/session.json`,
   com `events.jsonl` ao lado no formato `{ seq, event }` da aba Histórico.
   **Duas** sessões abrem o dashboard; uma só abre direto no detalhe.
2. `npm run build` e `ISSUE_FLOW_HOME=<home> node dist/cli.js web serve --port
   <p> --host 127.0.0.1`. O servidor lê os assets de `web/public/` (não uma
   cópia em `dist/`), então basta reiniciá-lo para pegar uma edição.
3. Uma sessão some após **90s** sem heartbeat: `touch` periódico no
   `session.json` a mantém viva pelo tempo da verificação.

Os estados que só aparecem sob condição se forçam do console: o `.banner` de
desconexão, substituindo `window.fetch` por um que rejeita (e restaurando
depois); o armazenamento bloqueado, com um `Object.defineProperty(window,
'localStorage', { get() { throw … } })` num script de inicialização; a troca de
tema do SO, pela emulação de `prefers-color-scheme` do DevTools, que dispara o
evento `change` real da media query.

Para contraste, **meça na página** (ler os tokens com
`getComputedStyle(document.documentElement)` e calcular a razão em JS), nunca a
partir dos valores no arquivo: só assim a cascata resolvida aparece, incluindo
o token que um tema herda do outro por engano.

## Escrita limitada a preferências futuras

O estado de execução continua somente leitura (`snapshot.readOnly === true`). As
únicas mutações são `POST /api/config/agent` e `POST /api/config/routing`, que
salvam preferências globais para execuções **futuras**, aparecem via capability
e só funcionam em loopback. Nunca inferir permissão pela versão: o client
renderiza os formulários apenas quando `/api/health.capabilities` anuncia as
duas capacidades correspondentes.

Cada mutação responde com `{ ok, file, appliesTo: 'future executions' }`; o
client atualiza a preferência viva no próximo `GET /api/config`, sem jamais
alterar o snapshot da execução. Enquanto as capabilities estiverem ausentes,
nenhum controle de escrita deve aparecer na tela.

## Métricas (tokens e custo)

`formatUsage()` espelha `formatTokens()` de `src/core/metrics.ts` — mesma
ordem de segmentos (`in / out · cache · ~$`) e mesma compactação
(`1.5k`/`2.4M`). Divergência proposital: o custo usa 2 casas decimais
(4 abaixo de um centavo), porque o painel prioriza leitura rápida enquanto o
terminal mostra precisão cheia. Se `metrics.ts` mudar de formato, atualize os
dois.

O agregado da issue vem de `snapshot.metrics` (chaves `total*`), a fase e a
story têm os campos direto no objeto (`inputTokens`, ...). Duração e métricas
compartilham o slot `.item-side`, unidos por `' · '` via `itemSideText()`,
que descarta as partes vazias — string vazia é o sinal de "não renderizar".
