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
`font-size: 0.78rem; font-weight: 600` — abaixo do que a WCAG chama de texto
grande. Já `--focus-ring` é um componente gráfico, não texto: 3:1 basta.

No tema claro as quatro cores de estado ficam no nível 700 da escala — é o tom
mais claro que ainda atende 4,5:1 sobre a superfície do próprio badge; `--state-ok`
(4,57) e `--state-warn` (4,51) passam por pouco. No tema escuro os
preenchimentos sólidos são claros, então `--accent-text` inverte para
`#0f1218`: era branco sobre `--state-error` no banner de desconexão, 2,98:1.

Hover e foco por teclado precisam ser **distinguíveis um do outro**. Em
`.dashboard-card` o hover só acende a borda (`--accent`); o foco desenha
`outline: 2px solid var(--focus-ring)` com `outline-offset: 2px`, que continua
visível em cima do hover. É a única regra do `app.css` que mexe em `outline` —
antes ela o suprimia e dava a mesma aparência aos dois estados.

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
