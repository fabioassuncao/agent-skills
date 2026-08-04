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
