# Absorption trace — behavioural chain per ported module

Required by [`§46`](research/2026-09-06-webmux-absorption.md) of the absorption
plan. Every module absorbed from WebMux carries the full chain here, written in
the same PR as the port:

```text
WebMux original → existing behaviour → Issue Flow implementation
                → adaptations → parity tests
```

A port PR without its block here is incomplete. The section
**"Behaviour deliberately NOT ported"** may be empty, but it may never be
absent: it is where a silent simplification becomes an explicit, reviewable
decision.

The one-line origin→destination mapping for each unit lives in
[`provenance.md`](provenance.md); this file holds the reasoning that a table row
cannot carry.

---

### Transporte push do monitor (Fase 1)

**WebMux original**
`.references/webmux-main/backend/src/server.ts` @ d8c9d5f — 2.790 linhas, das quais
importa aqui o caminho de saída: `sendWs()` (`:459`) e os três `ws.send` de `:464–:476`.
O upstream não consulta o estado; ele **empurra** cada chunk no instante em que o
callback do PTY dispara. É essa decisão — não o tmux, não o Bun — que responde por
`≈ 0 ms` contra os **3–8 s** medidos no Issue Flow (§5.4 da especificação).

**Comportamento existente**
- O servidor relia o SQLite a cada `DEFAULT_POLL_INTERVAL_MS = 3000`.
- O navegador relia o servidor a cada `refreshSeconds` (default `5`).
- Os dois saltos somavam a maior diferença de experiência medida em todo o estudo.
- Casos especiais que NÃO podiam se perder: o servidor jamais pode afetar a pipeline
  (falha de bind, erro de handler e erro de subscriber são engolidos); `session.json` e
  os JSONL continuam sendo projeções de compatibilidade que o monitor destacado nunca
  percorre; a janela de 90 s de heartbeat e o ETag por conteúdo continuam valendo; o
  backend legado de publisher único (fallback US-006) continua funcionando.

**Implementação no Issue Flow**
- `packages/issue-flow/src/web/session-directory.ts` — estratégia: **ADAPT**
- `packages/issue-flow/src/web/server.ts` (`/api/stream`) — estratégia: **ADAPT**
- `packages/issue-flow/web/public/app.js` (cliente `EventSource`) — estratégia: **ADAPT**

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| WebSocket → **Server-Sent Events** | Este canal carrega JSON reduzido em uma direção só: não precisa de framing, handshake de upgrade nem dependência nova, e reconecta sozinho. O transporte bidirecional do terminal (Fase 8) tem requisitos próprios — backpressure e replay incremental — e juntar os dois obrigaria ambos a carregar a união das restrições |
| Callback do PTY → **`fs.watch` na raiz de storage** | No WebMux o processo que produz o output é o mesmo que serve o WebSocket. No Issue Flow o monitor é um processo destacado: o commit SQLite da pipeline é o único evento que os dois lados já compartilham |
| Watch no **diretório**, não no arquivo | Um checkpoint do WAL apaga e recria `issue-flow.db-wal`; um watch preso a esse inode pararia de disparar exatamente uma vez, em silêncio. `fs.watch` não-recursivo em diretório é também o único modo que todas as plataformas suportadas implementam |
| Debounce de `WATCH_DEBOUNCE_MS = 20` | Um commit lógico produz vários eventos de filesystem (WAL e, no checkpoint, o arquivo principal). Colapsá-los custa 20 ms de um orçamento de 250 ms |
| `subscribe()` compara o snapshot **serializado** | O heartbeat de 10 s muda `updatedAt` sem mudar conteúdo. Tratar isso como mudança acordaria todo viewer conectado dez vezes por minuto à toa |
| Poll de 3 s **preservado como rede de segurança** | O driver de compatibilidade `json` não tem arquivo único para observar, e um watch que morre não pode rebaixar o monitor para sempre |
| Backend legado ganha `subscribe()` por tick de `version()` | `SessionPublisher` expõe contador monotônico e nenhuma notificação; é uma leitura em memória, iniciada no primeiro assinante e encerrada com o último |
| O painel usa o frame como **sinal**, não como segundo caminho de render | Duas rotinas de "aplicar estado na tela" divergiriam. `poll()` continua sendo a única |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| Prefixo de 1 caractere (`"o"`/`"s"`) no caminho quente | `server.ts:464–467` | Existe para evitar `JSON.stringify` por chunk de TTY. Este canal carrega estado JSON reduzido, algumas vezes por segundo; o prefixo economizaria nada e custaria um protocolo ad-hoc |
| Ausência de autenticação | `Bun.serve` sem `hostname` | ADR-10. As rotas de escrita continuam restritas a loopback e `/api/stream` é somente leitura; a autenticação obrigatória entra com o terminal (Fase 8), que é shell remoto |
| Replay de scrollback e backpressure | `terminal.ts` | Pertencem ao transporte do TTY (Fase 8). Aqui não há stream de bytes para truncar: cada frame é o estado corrente completo, e o mais recente torna o anterior irrelevante |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/web/session-directory.test.ts` — bloco *push notifications* | novo (§34, critério da Fase 1) | 5 | ✅ |
| `src/web/server.test.ts` — bloco *push transport* | novo (§34, critério da Fase 1) | 8 | ✅ |
| `src/web/stream-latency.integration.test.ts` | orçamento de §35 | 1 | ✅ |

Nenhum teste upstream foi portado nesta fase: o caminho equivalente do WebMux
(`backend/src/server.ts`) não tem testes no upstream congelado.

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| Latência output → tela (p95) | ≤ 250 ms (teto duro) | **54 ms** (mediana 51 ms, 10 amostras, `stream-latency.integration.test.ts`) |
| Antes da fase | — | 3–8 s (poll de 3 s no servidor + 5 s no navegador) |
