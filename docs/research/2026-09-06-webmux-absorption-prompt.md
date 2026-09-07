# Prompt mestre — execução da absorção do WebMux

> **Este arquivo é um prompt executável, não documentação.** Ele é o *executor*;
> [`2026-09-06-webmux-absorption.md`](2026-09-06-webmux-absorption.md) é a *especificação*.
> Nenhum dos dois funciona sozinho.
>
> **Como invocar** (uma fase, um intervalo ou o roadmap restante):
>
> ```text
> Execute o prompt mestre em docs/research/2026-09-06-webmux-absorption-prompt.md
> para a FASE <N>.
> ```
>
> A fase é opcional. Sem fase informada, o agente detecta no repositório a primeira fase
> ainda incompleta e executa, em ordem, todo o roadmap restante. Para retomar trabalho
> interrompido, use a mesma invocação: o protocolo de §5 detecta o estado real antes de
> decidir o que falta. Fases são unidades de sequenciamento e verificação, **não pontos de
> aprovação humana**.

---

## 0. Papel e missão

Você está absorvendo o **WebMux** (`windmill-labs/webmux@d8c9d5f`, v0.43.1) para dentro do
**Issue Flow**. A decisão arquitetural já foi tomada e não está em discussão. Sua missão é
**portar**, não reavaliar.

O objetivo não é `Issue Flow + WebMux`. É:

```text
Issue Flow + capacidades e implementações absorvidas do WebMux = novo Issue Flow
```

Você executa o escopo pedido — uma fase, um intervalo ou o roadmap restante — na ordem de
dependências de `§39` da especificação. Uma fase termina quando seu critério de conclusão
está satisfeito e verificado, não quando o código compila. Ao fechá-la, avance
automaticamente para a próxima fase dentro do escopo, sem solicitar confirmação.

### 0.1 Contrato de autonomia

A invocação deste prompt autoriza todas as mudanças locais razoavelmente necessárias para
entregar o escopo: criar, alterar, mover, remover e refatorar arquivos; atualizar schemas e
migrations; instalar, remover ou ajustar dependências e o lockfile; gerar artefatos;
executar testes, builds, linters, formatadores, benchmarks, smoke tests e validações de
integração; corrigir falhas diretamente relacionadas encontradas no caminho; e atualizar a
documentação afetada. Não transforme nenhuma recomendação, plano, gate ou fronteira de
fase em pedido de autorização.

Por padrão, a entrega inclui branch, commits, push e abertura ou atualização de um Pull
Request pronto para revisão, desde que o host permita efeitos remotos e as credenciais já
estejam disponíveis. Só omita a publicação quando a invocação disser `local-only` ou o
ambiente a impedir. Merge, deploy, release e publicação de pacote ficam fora do escopo
padrão por produzirem efeitos posteriores à entrega do código.

| Dimensão | Regra operacional |
|---|---|
| Escopo | Fases pedidas ou, sem seleção, roadmap restante; inclui pré-requisitos ausentes e correções diretamente relacionadas |
| Preservar | `headless`, contratos públicos, resiliência, verificação independente, telemetria, compatibilidade, dados e mudanças preexistentes do usuário |
| Pode modificar | Qualquer parte do repositório necessária à integração, respeitando os invariantes e as instruções locais; `.references/webmux-main/` é sempre somente leitura |
| Fora do escopo padrão | Linear, multi-tenant, merge, deploy, release, publicação npm e melhorias sem relação direta com a absorção |
| Entrega | Uma implementação por responsabilidade, dívida/deleções da fase resolvidas, documentação e migrations atualizadas, evidência reproduzível e PR pronto para revisão |

Resolva ambiguidades usando, nesta ordem:

1. o objetivo e as decisões arquiteturais desta especificação;
2. a arquitetura, os contratos e as instruções vigentes do repositório;
3. a preservação de compatibilidade, comportamento e garantias existentes;
4. simplicidade e manutenibilidade;
5. menor risco técnico;
6. a alternativa mais fácil de reverter.

Entre alternativas tecnicamente equivalentes, escolha sozinho a primeira que melhor
satisfizer essa ordem, registre decisões não óbvias no relatório e continue. Interrompa
somente a parcela realmente impossível de executar por falta de credencial indispensável,
acesso obrigatório indisponível ou decisão tecnicamente impossível de inferir com
consequência irreversível relevante. Antes disso, esgote alternativas locais e reversíveis;
se ainda houver bloqueio, documente evidências, conclua todas as partes independentes e
marque apenas o restante como bloqueado.

O estado final esperado é um único Issue Flow, sem implementações concorrentes, com as
capacidades previstas no roadmap integradas, compatibilidade e garantias preservadas,
deleções previstas concluídas, documentação e provenance atualizadas, e todos os gates
aplicáveis verdes. Se a invocação limitar expressamente o escopo, esse mesmo estado vale
para as fases solicitadas e seus pré-requisitos.

---

## 1. Fontes de verdade e precedência

```text
1. Instruções do usuário nesta sessão
2. AGENTS.md do repositório (raiz → diretório afetado) e os documentos que ele aponta
3. docs/research/2026-09-06-webmux-absorption.md          ← a especificação da absorção
4. .references/webmux-main/                               ← o upstream congelado (SOMENTE LEITURA)
5. Código atual do Issue Flow
```

**Regras sobre as fontes:**

- **`.references/webmux-main/` é imutável.** Nunca edite, mova, formate ou "corrija" nada
  ali. É a baseline de comparação; alterá-la destrói a capacidade de verificar paridade.
  Ela é `gitignored` (`.gitignore:3`) e não deve ser versionada.
- **A especificação não se re-deriva.** Se a spec afirma algo, isso já foi verificado no
  código-fonte. Não repita a investigação; siga.
- **A especificação pode estar desatualizada em relação ao Issue Flow**, que continua
  evoluindo. Se um caminho de arquivo citado não existir mais, **verifique o repositório e
  ajuste autonomamente**, registrando a divergência no relatório final (§8). Não invente.
- **Se a especificação e o `AGENTS.md` de um módulo se contradisserem, o `AGENTS.md`
  vence**. Adapte a implementação à regra de maior precedência, preserve o objetivo por
  outro caminho coerente e registre a contradição; ela não é, por si só, motivo para parar.

---

## 2. Economia de contexto — leia só o que a fase exige

A especificação tem **~117 KB**. Lê-la inteira a cada sessão é desperdício e piora o
resultado.

**Sempre leia (núcleo, ~22 KB):** `§1` (executive summary) · `§38` (ADRs) · `§42`
(metodologia) · `§35` (orçamentos) · `§25` (mapa de deleção) · **`§45` (maturidade comparada
por componente) · `§46` (rastreabilidade obrigatória)**.

**Depois leia apenas as seções da sua fase:**

| Fase | Objetivo | Seções obrigatórias | Seções de apoio |
|---|---|---|---|
| **0** | Baseline e provenance | `§0`, `§41` | — |
| **1** | Monitor por push | `§5.4`, `§15` | `§2.4` |
| **2** | Eventos por hook | `§2.5`, `§18`, `§45.2-D` | `§22`, `§23` |
| **2B** | Project Registry unificado | `§47` | `§45.1`, `§34` (P1–P12) |
| **3** | Runtime API (3 modos) | `§26`, `§27`, `§36` | `§21` |
| **4** | Convenções Git | `§8`, `§9`, `§10`, `§11`, `§24` | `§34` (G1–G11) |
| **5** | Worktree manager | `§12`, `§22`, `§45.2-E/F/G` | `§4.1` |
| **6** | Runtime tmux | `§2.3`, `§13`, `§31.2` | `§4.1` |
| **7** | Agent wrappers TTY | `§7`, `§2.4`, `§45.2-A/B/C/L` | `§16`, `§27` |
| **8** | Terminal web (backend) | `§2.4`, `§15` | `§37.2` |
| **8B** | Port do frontend | `§48` | `§45.1`, `§15` |
| **8C** | Funcionalidades do painel do Issue Flow | `§50`, `§48.4` | `§27` |
| **8D** | Consolidação de UX e remoção do antigo | `§50.4`, `§50.5`, `§50.7` | `§50.8` |
| **9** | Human-in-the-loop | `§32`, `§17` | `§30` |
| **9B** | Sessões livres | `§49` | `§27`, `§48.4` |
| **10** | Profiles e services | `§16`, `§19`, `§45.2-I/J/K` | `§2.3` |
| **11** | Reconciliação | `§30`, `§2.6`, `§27` | `§37.3` |
| **12** | Sandbox — paridade | `§14` (etapa 1), `§45.2-H` | `§22` |
| **13** | Sandbox — hardening | `§14` (etapa 2) | — |
| **14** | PR / CI / GitHub | `§20` | `§22` |
| **15** | Convergência do oneshot | `§17` | `§32` |
| **16** | Paralelismo | `§31` | `§30` |
| **17** | Multi-agente e handoffs | `§28`, `§29` | `§27` |

Para localizar uma seção sem carregar o arquivo inteiro:

```bash
grep -n '^## ' docs/research/2026-09-06-webmux-absorption.md
sed -n '<inicio>,<fim>p' docs/research/2026-09-06-webmux-absorption.md
```

---

## 3. Invariantes inegociáveis

Estes vêm de `§38` (ADR-01 a ADR-14). **Violá-los é motivo para reverter a mudança**, mesmo
que os testes passem.

### 3.1 Sobre o porte

1. **Nunca `COPY`. Sempre `PORT` ou `ADAPT`.** O backend do WebMux tem ~129 call sites de
   API exclusiva do Bun — nenhum arquivo compila em Node sem tradução. Isso também resolve
   a ausência de `LICENSE` no upstream.
2. **Traduções mecânicas obrigatórias:** `Bun.spawn`/`Bun.spawnSync` → `execa`
   (**com `extendEnv: false`** onde o WebMux substitui o env em vez de mesclá-lo) ·
   `Bun.file`/`Bun.write` → `node:fs/promises` · `Bun.env` → `process.env` · `Bun.sleep` →
   `node:timers/promises` · `Bun.serve` → `node:http` + `ws` · `Bun.connect` → `node:net`.
3. **Não redesenhe durante o porte.** Se algo do upstream parece errado, porte primeiro e
   registre uma melhoria separada depois. As três exceções já determinadas pela spec são:
   socket tmux dedicado (`-L issue-flow`, ADR-09), `reattach` não destrutivo (`§27`) e
   autenticação (ADR-10). Uma exceção adicional só é válida quando necessária para cumprir
   uma instrução superior, preservar compatibilidade/segurança ou tornar o port executável;
   escolha a menor mudança reversível, cubra-a com teste e registre a justificativa.
4. **Nunca porte e endureça na mesma mudança** (ADR-12). Paridade primeiro; hardening é
   fase própria.

### 3.2 Sobre o Issue Flow

5. **`AgentInvocation` e `AgentRunResult` não mudam de forma** (ADR-02). É isso que
   preserva failover, watchdog, resilience, telemetria e o reducer de sessão. Campos
   novos são **aditivos e opcionais**.
6. **`headless` continua sendo o default e nunca é removido** (ADR-03). Um repositório sem
   tmux, sem docker e sem worktree deve continuar funcionando exatamente como hoje.
7. **Preserve por padrão** `src/core/`, `src/resilience/`, `src/storage/` (exceto
   migrations), `src/telemetry/`, `src/verify/` e `src/routing/`. Toque neles apenas quando
   a fase ou uma correção diretamente necessária exigir integração real; nesse caso faça a
   menor alteração compatível, mantenha os contratos, amplie os testes e registre o motivo.
   São as garantias que o WebMux não tem e que a absorção não pode custar.
8. **Comandos de agente são montados como argv, nunca como string de shell** (ADR-04). A
   string de shell + `quoteShell` do WebMux **não é portada**.
9. **Estado do agente vem de hook, nunca de parsing de TTY** (ADR-05). Nenhuma decisão de
   workflow lê bytes do terminal (ADR-06).
10. **`review`, `verify` e `pr-review` nunca reutilizam sessão** (ADR-07) — nem por
    configuração explícita. A tentativa é erro de configuração e precisa de um teste que a
    defenda.
11. **Autoridade de estado** (ADR-08): o mundo externo (git, tmux, docker, provider) é
    autoridade sobre *existência e vida*; o SQLite é autoridade sobre *vínculo e intenção*.
    Divergência marca `orphaned` — **nunca** recria estado por otimismo.
12. **Nenhuma superfície web sem autenticação** (ADR-10). Bind explícito em `127.0.0.1`,
    token no handshake, validação de `Origin`. A ausência de auth do WebMux é a única parte
    explicitamente rejeitada.
13. **Sem sistemas duplicados** (`§25`). Ao terminar a fase, deve existir **uma**
    implementação por responsabilidade: um worktree manager, uma abstração Git, uma
    convenção de branch, um agent launcher, um session manager.
14. **Reconciliação usa chamadas agregadas** (ADR-13): `tmux list-windows -a` uma vez,
    nunca uma chamada por entidade. Medido O(1) até N=20.

### 3.3 Sobre convenções e idioma

15. **Código, comentários, nomes, mensagens de commit e corpo de PR em inglês**, como o
    resto do repositório. Comunicação com o usuário e documentos `docs/research/` em
    **pt-BR**.
16. **As convenções Git do repositório valem para o seu próprio trabalho.** Leia
    [`docs/git-conventions.md`](../git-conventions.md) antes do primeiro commit. Se a
    fase 4 já rodou, leia a versão atualizada — ela mudou.
17. **Artefatos de execução do Issue Flow (`~/.issue-flow`, `.issue-flow/`) nunca são
    commitados.**

### 3.4 Sobre não perder engenharia — a regra da maturidade

18. **Parta sempre da implementação mais madura, seja de quem for.** `§45.1` da spec diz,
    componente a componente, qual das duas bases é canônica: **8 partem do WebMux, 6 do
    Issue Flow, 2 são mescla**. Consulte a matriz antes de escrever a primeira linha —
    ela não é sugestão, é a decisão já tomada.

19. **Nunca simplifique sem entender por que a parte existe.** Antes de omitir qualquer
    trecho do original, você precisa conseguir responder *o que quebra sem isso*. Se não
    souber, o trecho **vai junto**. Detalhes que parecem ruído costumam ser o motivo da
    estabilidade observada. Exemplos reais, todos verificados, que uma reimplementação
    "limpa" perderia:
    - o merge de hooks que **preserva grupos alheios** no `settings.local.json` do usuário;
    - `resolveGitCommonDir()`, sem o qual o `info/exclude` vai para o lugar errado dentro
      de um worktree;
    - `rejectPending()` no `exited` do `codex app-server` — sem ele, a morte do daemon
      deixa promessas penduradas para sempre;
    - a identidade de bloco `${messageId}:${blockIndex}` do parser do Claude, que evita
      mensagem duplicada quando o mesmo bloco chega pelo stream e pela transcrição;
    - o suporte a **direnv** no runner de lifecycle hooks (`direnv exec` quando há `.envrc`);
    - `--mount type=bind` para o socket SSH, porque `-v` faz o Docker tentar `mkdir` no
      socket e falhar;
    - a defesa de locale UTF-8 do tmux, sem a qual `list-windows` some com todas as janelas.

20. **O risco é bidirecional — não deixe o porte rebaixar o Issue Flow.** Ao fim de cada
    fase, verifique a tabela de `§45.3`. Reintroduzir qualquer forma degradada é regressão,
    mesmo com todos os testes verdes. As mais fáceis de cometer sem perceber:
    `writeFileAtomic` → `writeFile` direto · chokepoint `run()` → `spawn` espalhado ·
    argv → string de shell · permissão semântica → `yolo: boolean` · superfície web com
    auth → bind sem credencial.

21. **Toda unidade portada produz sua ficha de rastreabilidade** (`§46`) em
    `docs/absorption-trace.md`, na mesma PR. A seção *"Comportamento deliberadamente NÃO
    portado"* pode estar vazia, mas nunca ausente: é onde uma simplificação silenciosa
    vira decisão explícita e revisável.

22. **Um único conceito de projeto** (`§47`). CLI, servidor, painel e runtime consultam o
    **mesmo** `ProjectRegistry`, cuja chave é o `projectId` do Issue Flow
    (`projectIdFromRemote`), nunca o path. O registry guarda apenas o necessário para
    reencontrar e operar o projeto — nada que possa ser derivado do repositório. Não
    crie um segundo arquivo de estado ao lado do SQLite, e não faça o CLI depender de
    um servidor no ar.

23. **O frontend é portado, não reimplementado** (ADR-15). Svelte 5, Tailwind 4, Vite 6,
    xterm.js, `diff2html` e o pacote de contrato vêm junto e **substituem** o monitor
    vanilla. Preserve componentes, estado em runes, navegação por prefixo de URL,
    superfície mobile e os 148 casos de teste. Adapte apenas rotas e contratos; acrescente
    os conceitos do Issue Flow (Tasks, execuções, stories, verificação, review) **sem
    destruir** o fluxo que já funciona. Antes de mexer, leia `§48`.

24. **Dois modos de sessão, um só modelo** (ADR-16). `AgentSession` tem `run_id`, `phase` e
    `story_id` **nuláveis**: sessão livre é a mesma entidade com esses campos vazios. Nunca
    crie um segundo modelo de execução, nunca exija issue/plano/workflow para abrir um
    agente, e nunca deixe a pipeline reaproveitar uma sessão livre em `review`/`verify`
    (ADR-07 continua valendo). Antes de mexer, leia `§49`.

25. **Nenhuma capacidade do painel atual se perde** (ADR-18). O frontend do WebMux é a
    **base estrutural**; as funcionalidades do painel do Issue Flow são **portadas sobre
    ela**, não descartadas: dashboard de execuções, abas com ARIA, os quatro blocos,
    Kanban, histórico, drawer com timeline de tentativas, tema, métricas, retro-
    compatibilidade de `session.json` e as escritas limitadas a loopback. O
    `web/AGENTS.md` atual — 18 pares de contraste medidos, glossário pt-BR, escalas
    fechadas — **migra junto**, adaptado. O painel antigo só sai quando os três blocos de
    `§50.7` estiverem verdes; até lá convive em `/legacy`. Antes de mexer, leia `§50`.

---

## 4. Metodologia obrigatória por componente

Aplique a cada linha da tabela `§22` que pertença à sua fase. A ordem não é sugestão.

```text
UNDERSTAND → CHARACTERIZE → PORT → COMPILE → PORT TESTS → VERIFY PARITY
           → INTEGRATE → REMOVE DUPLICATE → IMPROVE
```

| Passo | O que significa | Como você sabe que terminou |
|---|---|---|
| **UNDERSTAND** | Ler o arquivo upstream **inteiro** em `.references/webmux-main/<path>`, a ficha do componente em `§45.2` e as seções da fase | Você consegue explicar **por que cada tratamento especial existe**, não só o que cada função faz |
| **CHARACTERIZE** | Escrever o teste de caracterização de `§34` **antes** de escrever código de produção | O teste existe, roda e **descreve o comportamento atual** |
| **PORT** | Traduzir Bun→Node preservando **estrutura, nomes, comentários explicativos e todo tratamento especial**. Omissão exige justificativa escrita | Estrutura reconhecível lado a lado com o original; nada omitido sem linha em *"NÃO portado"* |
| **COMPILE** | `npm run typecheck` | Zero erros |
| **PORT TESTS** | Migrar os testes upstream listados em `§22` (`bun:test` → `vitest`) | Contagem de casos portados registrada |
| **VERIFY PARITY** | Comparar saída com o upstream (`§34`), medir contra `§35` e conferir `§45.3` | Caracterização verde + budgets respeitados + nenhuma garantia do Issue Flow rebaixada |
| **INTEGRATE** | Ligar ao Issue Flow (config, CLI, storage, monitor) | Caminho de ponta a ponta exercitado |
| **REMOVE DUPLICATE** | Deletar o que `§25` manda deletar nesta fase | `grep` não encontra a implementação antiga |
| **IMPROVE** | Só agora; corrija o necessário ao escopo e registre melhorias não relacionadas sem expandi-lo | — |

**Proibido:** `UNDERSTAND → REDESIGN → REWRITE`.

---

## 5. Protocolo de execução de uma fase

### 5.1 Entrada — antes de escrever qualquer código

1. Determine pelo pedido e pelo estado real qual é a primeira fase do escopo e leia sua
   linha em `§39` (objetivo, ADD/MIGRATE/DEPRECATE/DELETE, dependências, risco e critério de
   conclusão). Sem fase informada, comece pela primeira incompleta e inclua o roadmap
   restante.
2. **Verifique as dependências no repositório, não no documento.** Se a fase 6 depende da
   3 e da 5, procure `src/runtime/types.ts` e `src/runtime/worktree/`. Se faltarem,
   implemente primeiro os pré-requisitos ausentes na ordem do roadmap. Se algum depender
   de recurso externo inacessível, avance nas dependências e fases independentes e bloqueie
   somente a parcela afetada.
3. Leia o núcleo (§2) + as seções mapeadas da fase.
4. Leia os `AGENTS.md` dos diretórios que você vai tocar.
5. Inspecione o estado atual: `git status`, branch e trabalho parcial da mesma fase.
   Preserve mudanças preexistentes e incorpore trabalho parcial válido em vez de refazê-lo.
6. **Produza e siga um plano curto de trabalho**, sem submetê-lo à aprovação: arquivos a
   criar/alterar/remover, testes a portar e validações. Atualize-o quando os fatos exigirem;
   divergências relevantes da spec entram no relatório.

### 5.2 Branch e commits

- Um escopo de entrega = uma branch = um PR. Uma fase isolada é um escopo; um intervalo ou
  o roadmap restante usa uma única branch, salvo regra explícita do repositório em
  contrário. A fronteira de fase é checkpoint técnico e de commit, nunca gate humano.
- Commits atômicos por passo da metodologia (`CHARACTERIZE`, `PORT`, `PORT TESTS`,
  `REMOVE DUPLICATE`), não um commit por arquivo nem um commit gigante no fim.
- Faça push e abra/atualize o PR automaticamente depois dos gates, sem pedir nova
  autorização, salvo invocação `local-only` ou impedimento do ambiente. Não faça merge,
  deploy, release ou publicação de pacote a menos que a invocação os inclua expressamente;
  a ausência dessas ações não bloqueia a implementação.

### 5.3 Verificação — os comandos reais

```bash
cd packages/issue-flow

npm run typecheck          # tsc --noEmit
npm run lint               # biome check .
npm run check              # biome check . && tsc --noEmit
npm test                   # vitest run
npm run test:integration   # vitest run --config vitest.integration.config.ts
npm run build              # skills:sync + build:cli; valida artefatos empacotados
npm run smoke              # pipeline isolada com agentes/gh determinísticos
```

Testes ficam **ao lado do código** (`foo.ts` → `foo.test.ts`). Testes que exigem `git`,
`tmux` ou `docker` reais vão para a configuração de integração, nunca para a suíte
padrão. Rode `test:integration` quando a fase tocar nesses limites e `smoke` quando alterar
CLI, empacotamento ou o fluxo de ponta a ponta. Se houver migration, teste banco novo,
banco existente migrado, reabertura e compatibilidade de leitura; nunca dependa de
migration aplicada manualmente pelo usuário.

Se a fase tocar em `skills-src/`: `npm run skills:check` e `npm run skills:test`.

Se uma dependência necessária não estiver instalada ou precisar mudar, use o gerenciador
e a versão de runtime definidos pelo repositório, atualize manifest e lockfile juntos,
justifique a escolha em documentação/provenance quando relevante e continue. Falhas de
check são trabalho a corrigir e reexecutar, não checkpoints para consultar o usuário.

### 5.4 Gates de conclusão — todos obrigatórios

Uma fase só termina quando **todos** forem verdadeiros:

- [ ] `npm run check` limpo
- [ ] `npm test` verde, **sem testes existentes removidos ou marcados como skip**
- [ ] `npm run build` verde; fontes e artefatos gerados sincronizados
- [ ] `npm run test:integration` e `npm run smoke` verdes quando aplicáveis à fase, ou
      justificativa técnica objetiva de não aplicabilidade registrada
- [ ] Migrations da fase validadas em banco novo e existente, incluindo reabertura e
      compatibilidade, quando aplicável
- [ ] Testes de caracterização da fase (`§34`) verdes
- [ ] Testes upstream da fase portados, com a contagem registrada
- [ ] Orçamentos de `§35` da fase medidos e respeitados (`§6` abaixo)
- [ ] Deleções de `§25` para esta fase executadas
- [ ] Zero implementações duplicadas (invariante 13)
- [ ] `docs/provenance.md` atualizado (`§7`)
- [ ] Ficha de rastreabilidade em `docs/absorption-trace.md` para cada unidade portada (`§46`)
- [ ] Checklist do risco inverso (`§45.3`) conferido — nenhuma garantia rebaixada
- [ ] Documentação afetada atualizada (`docs/`, `AGENTS.md` do módulo)
- [ ] Relatório final produzido (`§8`)

Gate vermelho inicia diagnóstico, correção e nova execução automaticamente. Se um bloqueio
real de §9 impedir o fechamento, marque a fase como parcial, preserve a evidência e continue
pelas fases independentes; não converta o gate em solicitação de validação humana.

---

## 6. Orçamentos de performance

Os números de `§35` da spec vêm de medição real, não de estimativa. Meça de novo depois do
porte, no mesmo estilo (mediana de ≥3 execuções, wall clock em milissegundos).

| Métrica | Baseline WebMux | Budget Issue Flow |
|---|---|---|
| `git worktree add` | 78 ms | ≤ 150 ms |
| `ensureSessionLayout` (2 panes) | 254 ms | ≤ 400 ms |
| Custo marginal por sessão adicional | 15 ms | ≤ 30 ms |
| Reconciliação (`list-windows -a`) | 23 ms | ≤ 50 ms **e obrigatoriamente O(1) em N** |
| T0→T4 (worktree pronto + agente iniciado) | ≈ 350 ms | ≤ 600 ms |
| Entrega de prompt subsequente (20 KB) | 35 ms | ≤ 80 ms |
| Reconexão de terminal | 28 ms + replay | ≤ 100 ms |
| **Latência output → tela** | ≈ 0 ms (push) | **≤ 250 ms p95 — teto duro** |
| Boot do CLI | n/a | ≤ 250 ms |
| Contexto re-ingerido por story após a 1ª invocação | 0 | **0 — invariante** |

Estourar um budget **não** é motivo para desistir: diagnostique, implemente a correção e
meça novamente, registrando o número antes/depois. A única linha sem margem de negociação
é a latência output→tela — não existe justificativa aceitável para voltar ao polling de
3–8 s no caminho interativo.

---

## 7. Provenance obrigatória

Toda unidade portada adiciona **uma linha** em `docs/provenance.md`, na mesma PR:

```markdown
| Destino | Origem upstream | Repo | Commit | Estratégia | Licença declarada |
|---|---|---|---|---|---|
| src/runtime/tmux/gateway.ts | backend/src/adapters/tmux.ts | windmill-labs/webmux | d8c9d5f | PORT | package.json: MIT (sem LICENSE) |
```

Regras: **nenhum cabeçalho de licença por arquivo**; `NOTICE` na raiz reconhece o WebMux
como origem arquitetural; enquanto o upstream não publicar `LICENSE`, nenhum arquivo é
copiado literalmente — o que o invariante 1 já garante.

---

## 8. Relatório de fase e entrega

Registre este bloco ao fechar cada fase, mesmo quando ela ficar incompleta, e prossiga para
a próxima fase dentro do escopo. No fim da sessão, reúna os blocos no relatório da entrega;
produzir o relatório não cria uma pausa para aprovação.

```markdown
## Fase <N> — <objetivo>

**Estado:** concluída | parcial | bloqueada

### Portado
| Origem upstream | Destino | Estratégia | Base canônica (§45.1) | LOC |

### Rastreabilidade
Ficha em `docs/absorption-trace.md` para: <módulos>. Cada uma com
`WebMux original → comportamento existente → implementação → adaptações → testes de paridade`.

### Comportamento deliberadamente NÃO portado
| O quê | Origem | Por quê |
<ou "nenhum">

### Risco inverso (§45.3)
| Garantia do Issue Flow | Preservada? |

### Testes
- Portados: <n> casos, de <arquivo upstream> → <arquivo destino>
- Caracterização: <ids de §34> — verdes/vermelhos
- Suíte: `npm run check` ✅ · `npm test` ✅ (<n> passando)

### Orçamentos medidos
| Métrica | Budget | Medido | Veredito |

### Deletado
| O quê | Onde | Substituído por |

### Divergências em relação à especificação
<caminho que mudou, decisão que não coube, contradição com AGENTS.md — ou "nenhuma">

### Decisões autônomas relevantes
<escolha, evidência e justificativa — ou "nenhuma">

### Bloqueios externos remanescentes
<credencial/recurso/decisão irreversível realmente impeditiva, alternativas tentadas e
trabalho independente concluído — ou "nenhum">

### Próxima fase
Fase <N+1> — <objetivo>. Dependências satisfeitas: sim/não. Ação tomada: iniciada |
pré-requisito implementado | independente concluída | bloqueada por <evidência>.
```

---

## 9. Decisão autônoma e bloqueios reais

Não peça aprovação, confirmação, validação ou escolha durante a execução para resolver:

- pré-requisito de fase ausente — implemente-o primeiro;
- divergência entre a spec e o código atual — siga a precedência de §1 e adapte;
- alteração necessária fora dos caminhos originalmente previstos — faça a menor mudança
  coerente e cubra-a com testes;
- dependência nova — avalie manutenção, segurança, compatibilidade e custo, escolha a
  alternativa mais simples tecnicamente adequada e atualize manifest/lockfile;
- budget excedido — diagnostique, corrija e meça novamente; se não atingir o teto sem
  comprometer invariantes, entregue o melhor resultado seguro com evidência e risco
  residual explícitos;
- nomes, layout de arquivos, APIs internas, ordem de parâmetros, formato de teste, idioma
  visível ou outra decisão reversível. O idioma já está decidido em `§50.4`: pt-BR;
- avanço de fase, execução de migrations locais/de teste, geração de artefatos, correções
  relacionadas, documentação, commits e publicação do PR quando incluída no escopo.

Só existe bloqueio quando **todas** as alternativas razoáveis falharem e restar uma destas
condições:

1. credencial indispensável ausente e sem caminho local/offline;
2. acesso indisponível a recurso externo obrigatório e sem fixture, cache, mock ou etapa
   local equivalente;
3. decisão impossível de inferir tecnicamente que possa produzir consequência externa
   irreversível relevante.

Mesmo então, não paralise o trabalho inteiro: preserve os logs/evidências, marque apenas a
parte afetada como bloqueada, complete todas as fases e validações independentes e deixe
uma descrição objetiva do que falta. Limites impostos pelo ambiente do agente continuam
valendo; tente caminhos permitidos, mas não os contorne.

---

## 10. Anti-padrões — o que nunca fazer

| Nunca | Porque |
|---|---|
| Copiar arquivo do WebMux sem traduzir | Não compila em Node; e a licença upstream não está publicada |
| Editar `.references/webmux-main/` | Destrói a baseline de verificação de paridade |
| "Melhorar" durante o porte | Torna regressão indistinguível de bug (ADR-12) |
| Montar comando de agente como string de shell | Reintroduz injeção que o argv já elimina (ADR-04) |
| Ler estado do agente do TTY | TUIs mudam entre releases e o parser produz dado plausível e errado (ADR-05) |
| Reutilizar sessão em `review`/`verify` | Destrói a independência que torna `verified` uma afirmação (ADR-07) |
| Recriar estado quando git/tmux/docker discordam do banco | Autoridade é do mundo externo (ADR-08) |
| Expor terminal sem autenticação | É shell remoto; é a única parte do WebMux rejeitada (ADR-10) |
| Fazer `headless` depender de tmux/docker/worktree | Quebra CI e o comportamento atual (ADR-03) |
| Deixar duas implementações da mesma responsabilidade | O objetivo é substituição, não acúmulo (`§25`) |
| Marcar teste como `skip` para fechar a fase | Gate de `§5.4` |
| Portar a integração Linear | `DISCARD` explícito; volta como Issue Provider, se voltar |
| Simplificar um trecho do original sem saber o que quebra sem ele | É justamente o que explica a estabilidade observada (invariante 19) |
| Reimplementar do zero um componente cuja base canônica é o WebMux (`§45.1`) | Perde comportamento e joga fora os testes upstream que o protegem |
| Portar `adapters/fs.ts` com `writeFile` direto | O WebMux **não** faz escrita atômica; o Issue Flow faz. Seria regressão (`§45.0`) |
| Substituir `utils/shell.ts` pelo `lib/shell.ts` do WebMux | O do Issue Flow é mais maduro: chokepoint único + allowlist destrutiva (`§45.2-F`) |
| Reimplementar um componente do frontend em vanilla/outra stack | ADR-15: o frontend é portado integralmente em Svelte |
| Obrigar toda sessão a nascer de uma issue, task, plano ou workflow | ADR-16: sessão livre é um modo de primeira classe (`§49`) |
| Deixar o Roteiro B (workflow) quebrar o Roteiro A (sessão livre) | ADR-17: paridade do WebMux é pré-requisito de aceitação (`§48.6`) |
| Remover `web/public/` antes dos três blocos de `§50.7` verdes | ADR-18 |
| Copiar telas do painel antigo para Svelte sem analisar dados, APIs e estados | `§50.3`: onde há sobreposição, uma só experiência — não duas páginas |
| Escrever cor literal em classe utilitária Tailwind | ADR-19: os tokens do Issue Flow são a fonte da verdade e a tabela de contraste é o gate |
| Usar "sessão" como sinônimo de "execução" (ou vice-versa) | ADR-20: são conceitos distintos no glossário |
| Fechar a fase sem a ficha em `docs/absorption-trace.md` | Gate de `§5.4`; sem ela a adaptação não é auditável |
| Criar um `projects.json` ao lado do SQLite | A tabela `projects` já existe e é a autoridade (`§47.2`) |
| Chavear o registry por path em vez de `projectId` | Perde a identidade estável por remote que o Issue Flow já tem (`§47.2`) |
| Fazer `issue-flow project ls` exigir servidor no ar | O CLI precisa funcionar offline; só o WebMux podia assumir servidor (`§47.5`) |
| Adotar **Bun** como runtime | `DISCARD` explícito (ADR-01). Svelte, Tailwind, Vite, xterm.js, `diff2html` e `@ts-rest/core` **são adotados** — ver ADR-15 |
| Transformar plano, gate, relatório ou fronteira de fase em pedido de aprovação | O contrato de §0.1 exige progressão autônoma; checkpoints servem para verificar, não para esperar |

---

## 11. Referência rápida das fases

Fonte: `§39` da especificação. ⭐ = entrega valor sozinha, sem depender de tmux, worktree,
docker ou sessão.

| Fase | Objetivo | Depende de | Risco | Critério de conclusão |
|---|---|---|---|---|
| 0 | Baseline congelada e provenance | — | nenhum | SHA registrado, `diff -rq` limpo (**feito**) |
| 1 ⭐ | Monitor por push | — | baixo | p95 output→tela ≤ 250 ms |
| 2 ⭐ | Eventos de agente por hook | — | baixo | `awaiting_input` visível num `execute` headless |
| 2B ⭐ | Project Registry unificado (CLI + servidor + painel) | — | baixo | P1–P12 verdes; `serve` com 3 projetos; `run` direto inalterado |
| 3 | Runtime API (headless/interactive/sandbox) | 2 | médio | suíte atual 100% verde, sem mudança de comportamento |
| 4 | Convenções Git | — | médio | G1–G11 verdes; `docs/git-conventions.md` menor |
| 5 | Worktree manager | 3 | médio | C1, C12 verdes; budget 150 ms |
| 6 | Runtime tmux | 3, 5 | alto | C3 verde; budget 400 ms; sem tmux degrada limpo |
| 7 | Agent wrappers TTY e sessões | 6 | alto | C4, C5 verdes; prompt no argv; `--resume` funcional |
| 8 | Terminal web (backend) | 7 | alto | C6, C9 verdes; backpressure e replay incremental testados |
| 8B ⭐ | Port integral do frontend Svelte | 8 | alto | Roteiro A de §48.6 completo; painel antigo intacto em `/legacy` |
| 8C | Funcionalidades do painel do Issue Flow na nova base | 8B | alto | Bloco 2 de §50.7 (U1–U21) verde |
| 8D | Consolidar UX e remover o painel antigo | 8C | médio | Bloco 3 (I1–I7) verde; só então o antigo sai |
| 9 | Human-in-the-loop | 8 | médio | C10 verde; watchdog não mata sob `human_hold` |
| 9B ⭐ | Sessões livres (sem issue/workflow) | 9 | médio | S1–S7 verdes |
| 10 | Profiles e service health | 6 | médio | C8 verde |
| 11 | Reconciliação | 5, 6, 7 | médio | matriz de `§30` coberta por teste |
| 12 | Sandbox — paridade | 6 | médio | C7 verde (args idênticos) |
| 13 | Sandbox — hardening | 12 | baixo | threat model de `§14` endereçado |
| 14 | PR / CI / GitHub canônico | — | baixo | uma implementação por responsabilidade |
| 15 | Convergência do oneshot | 9 | médio | `run` cobre 100% do `oneshot` |
| 16 | Paralelismo | 11 | alto | 5 execuções simultâneas; budget 30 ms/sessão |
| 17 | Multi-agente e handoffs | 16 | alto | handoff persistido e consumido entre fases |

---

## 12. Comece aqui

```text
1. Determine o escopo pelo pedido; sem fase, detecte a primeira incompleta e inclua o
   roadmap restante.
2. Leia o núcleo (§1, §38, §42, §35, §25, §45, §46 da spec) e as seções da fase (§2 deste
   prompt).
3. Para cada componente da fase, leia a ficha em §45.2 e verifique a base canônica em
   §45.1.
4. Verifique as dependências NO REPOSITÓRIO.
5. Registre um plano curto de trabalho, dizendo de qual base cada componente parte, e
   execute-o sem aguardar aprovação.
6. Execute a metodologia de §4, componente por componente.
7. Escreva a ficha de rastreabilidade de cada unidade portada (§46 da spec).
8. Feche os gates de §5.4, incluindo o checklist do risco inverso.
9. Produza o relatório de §8.
```

Se a fase não foi informada, **não pergunte**. Determine o progresso por arquivos,
migrations, testes, rastreabilidade e gates — nunca apenas pelo número da versão ou por uma
suposição — e prossiga da primeira fase incompleta até o estado final de §0.1.
