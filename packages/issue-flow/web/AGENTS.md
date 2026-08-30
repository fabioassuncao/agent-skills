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

Com **uma** sessão ativa o painel abre direto no detalhe (comportamento
histórico). Com **duas ou mais**, `renderDashboard()` lista um card por
execução; o clique define `state.selectedSessionId` e o poll passa a usar o
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

O painel tem três abas ("Execução", "Kanban" e "Histórico") e um drawer de detalhes por
story. Três regras seguram esse conjunto:

- **Acesso a story sempre por `getStoryById()` / `getStories()`.** Elas são a
  camada de leitura: normalizam num lugar só o que pode faltar num
  `session.json` antigo (`status` → `'backlog'`, `dependencies`/
  `acceptanceCriteria` → `[]`, `description` → `''`) e são o ponto onde uma
  futura camada de escrita entra. Nenhum consumidor varre `snapshot.stories`
  por conta própria, ou a normalização se espalha.
- **Estado de UI vive em `state`** (`activeTab`, `selectedStoryId`), junto de
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

## Escrita: o que ainda não existe

A interface é somente leitura por contrato (`snapshot.readOnly === true`,
`capabilities: []`), e o servidor não registra nenhuma rota de escrita — o
comentário em `src/web/server.ts` reserva `POST /api/control/*` para isso. O
Kanban e o drawer foram desenhados para que a escrita caiba depois sem
redesenhar a interação: o drawer já é o lugar onde uma story é inspecionada por
id, e `getStoryById()` já é o único ponto por onde ela é lida.

Quando essa etapa chegar, o contrato esperado é: as rotas de escrita passam a
ser anunciadas em `capabilities` (o client decide o que renderizar a partir
disso, nunca da versão do servidor), `readOnly` passa a `false`, e cada
mutação responde com o snapshot atualizado para que a UI não precise adivinhar
o efeito nem esperar o próximo poll. Enquanto `capabilities` estiver vazio,
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
