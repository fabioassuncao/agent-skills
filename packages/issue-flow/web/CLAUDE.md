# web/public — painel de monitoramento

Três arquivos estáticos servidos por `src/web/server.ts` (que os lê de
`web/public` tanto rodando de `src/` quanto do `dist/` publicado). São
assets do pacote: entram no `files` do package.json e **não** passam por
build, typecheck, biome (`files.includes` cobre só `src/**/*.ts`) nem
vitest. Toda verificação de mudança aqui é manual, no navegador.

## Contrato de dados

O painel consome só `GET api/status` (o `SessionSnapshot` serializado) e
`GET api/health`. Ele precisa renderizar **session.json de execuções
antigas**, então todo campo pode chegar como `undefined` (não existia na
versão que gravou o arquivo) além do `null` (existe, não informado). Os dois
significam "não informado" e nunca podem virar `0`, `NaN` ou `undefined` na
tela — daí o helper `metric()`, que normaliza qualquer coisa que não seja
número finito para `null`. Prefira `x !== null && x !== undefined` a `!x`:
zero é um valor legítimo.

Texto dinâmico sempre via `textContent`/`el()`; nunca `innerHTML` com dados
do snapshot.

## Abas, Kanban e drawer

O painel tem duas abas ("Execução" e "Kanban") e um drawer de detalhes por
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
- **`renderKanban()` e `renderDrawer()` são chamadas incondicionalmente** dentro
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
