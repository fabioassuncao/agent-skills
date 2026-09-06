// Interface do monitoramento web do issue-flow.
// JS puro, sem framework e sem recursos externos — funciona offline.
// Consome GET api/sessions, GET api/status (ETag/304), GET api/events e GET api/health;
// todo texto dinâmico entra via textContent (nunca innerHTML com dados
// do snapshot).
//
// A atualização chega por PUSH: o painel assina GET api/stream (Server-Sent
// Events) e o servidor avisa quando o estado de alguma sessão muda. O
// intervalo do seletor deixou de ser o caminho de entrega e virou apenas o
// fallback de quando o stream não está conectado — era ele, somado ao poll de
// 3 s do servidor, que produzia os 3–8 s medidos entre a saída do agente e a
// tela.
(() => {
  const REFRESH_OPTIONS = [3, 5, 10, 30];
  const PAUSED = 0;
  const STORAGE_KEY = 'issue-flow:refresh-seconds';
  const THEME_STORAGE_KEY = 'issue-flow:theme';
  // Esta chave também é lida pelo <script> inline do <head>
  // do index.html, que aplica o tema antes do primeiro paint. A duplicação
  // é deliberada: aquele script roda antes deste arquivo existir na página e
  // não pode depender de nenhum símbolo daqui. Mudou o formato do valor,
  // mude nos dois lugares.
  const MAX_BACKOFF_MS = 60000;
  const ALERT_PREVIEW = 3;
  const DESCRIPTION_PREVIEW = 140;

  const STATUS_LABELS = {
    idle: 'aguardando',
    running: 'executando',
    completed: 'concluído',
    failed: 'falhou',
  };

  // O resumo do dashboard conta *execuções* (feminino), então não reaproveita
  // STATUS_LABELS, que qualifica a execução no masculino usado pelo badge.
  const SUMMARY_STATUS_ORDER = ['running', 'idle', 'completed', 'failed'];
  const SUMMARY_STATUS_LABELS = {
    running: ['em execução', 'em execução'],
    idle: ['aguardando', 'aguardando'],
    completed: ['concluída', 'concluídas'],
    failed: ['com falha', 'com falha'],
  };

  const PHASE_ICONS = {
    pending: '○',
    running: '●',
    completed: '✓',
    failed: '✗',
  };

  const STORY_STATUS_LABELS = {
    backlog: 'backlog',
    in_progress: 'em andamento',
    in_review: 'em revisão',
    done: 'concluída',
  };

  // Rótulos do `stage` granular (issue 38) — mais fino que STORY_STATUS_LABELS,
  // deriva de eventos reais do pipeline (iteration:start, stories:update,
  // phase:start/phase:end da review, correction:cycle). Ver README, seção
  // "Story stage".
  const STORY_STAGE_LABELS = {
    pending: 'aguardando',
    executing: 'em execução',
    awaiting_review: 'aguardando revisão',
    in_review: 'em revisão',
    in_correction: 'em correção',
    done: 'concluída',
    failed: 'falhou',
  };

  // Colunas do Kanban, na ordem em que a execução avança. Os títulos são os das
  // colunas, não os rótulos dos badges (STORY_STATUS_LABELS), que seguem em minúsculas.
  const KANBAN_COLUMNS = [
    { status: 'backlog', title: 'Backlog' },
    { status: 'in_progress', title: 'Em andamento' },
    { status: 'in_review', title: 'Em revisão' },
    { status: 'done', title: 'Concluído' },
  ];

  const els = {
    banner: document.getElementById('banner-disconnected'),
    viewDashboard: document.getElementById('view-dashboard'),
    viewDetail: document.getElementById('view-detail'),
    dashboard: document.getElementById('dashboard'),
    dashboardMeta: document.getElementById('dashboard-meta'),
    backToDashboard: document.getElementById('back-to-dashboard'),
    issueLink: document.getElementById('issue-link'),
    issueHeadline: document.getElementById('issue-headline'),
    branchLine: document.getElementById('branch-line'),
    statusBadge: document.getElementById('status-badge'),
    elapsed: document.getElementById('elapsed'),
    estimate: document.getElementById('estimate'),
    refreshSelect: document.getElementById('refresh-select'),
    refreshSelectDashboard: document.getElementById('refresh-select-dashboard'),
    themeSelect: document.getElementById('theme-select'),
    themeSelectDashboard: document.getElementById('theme-select-dashboard'),
    alerts: document.getElementById('alerts'),
    alertsBody: document.getElementById('alerts-body'),
    issueSummary: document.getElementById('issue-summary'),
    repository: document.getElementById('repository'),
    progressBar: document.getElementById('progress-bar'),
    progressPercent: document.getElementById('progress-percent'),
    progressCounters: document.getElementById('progress-counters'),
    now: document.getElementById('now'),
    resilience: document.getElementById('resilience'),
    configuration: document.getElementById('configuration'),
    appVersion: document.getElementById('app-version'),
    appVersionDashboard: document.getElementById('app-version-dashboard'),
    dashboardSummary: document.getElementById('dashboard-summary'),
    phases: document.getElementById('phases'),
    nextSteps: document.getElementById('next-steps'),
    stories: document.getElementById('stories'),
    commits: document.getElementById('commits'),
    pullRequests: document.getElementById('pull-requests'),
    logFilter: document.getElementById('log-filter'),
    logs: document.getElementById('logs'),
    historyFilter: document.getElementById('history-filter'),
    history: document.getElementById('history'),
    sessionMeta: document.getElementById('session-meta'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('[role="tab"]')),
    kanban: document.getElementById('kanban'),
    drawer: document.getElementById('drawer'),
    drawerOverlay: document.getElementById('drawer-overlay'),
    drawerClose: document.getElementById('drawer-close'),
    drawerTitle: document.getElementById('drawer-title'),
    drawerBody: document.getElementById('drawer-body'),
  };

  const state = {
    snapshot: null,
    etag: null,
    refreshSeconds: 5,
    failures: 0,
    timer: null,
    polling: false,
    logFilter: 'all',
    activeTab: 'tab-execution',
    // 'system' | 'light' | 'dark'. Valor inicial em initTheme(), lido da
    // preferência guardada em localStorage por readStoredTheme().
    theme: 'system',
    historyFilter: 'all',
    events: [],
    diagnostics: [],
    // Só o id: o card que abriu o drawer é destruído no próximo render, então
    // guardar o nó levaria a uma referência morta.
    selectedDetail: null,
    configWritable: false,
    configData: null,
    // Identifica o processo que serviu os assets atuais. Uma troca significa
    // que --restart-web colocou código novo no mesmo origin e exige reload.
    serverInstanceId: null,
    // Versão do monitor, vinda de /api/health. Null enquanto não respondeu.
    monitorVersion: null,
    // Multi-sessão (#35): lista de /api/sessions e seleção explícita do usuário.
    // selectedSessionId null = modo automático (1 sessão → detalhe; 2+ → dashboard).
    sessions: [],
    selectedSessionId: null,
    // sessionId cujo snapshot/detalhe está na tela (evita flash ao trocar).
    detailSessionId: null,
    viewMode: 'detail', // 'detail' | 'dashboard'
    statusUrl: 'api/status',
    eventsUrl: null,
    // Se selectSession/clearSessionSelection chega durante um poll, reexecuta.
    pollAgain: false,
  };

  // Transporte push. `source` é o EventSource aberto; `connected` só é true
  // entre o frame `hello` e o primeiro erro, e é o que desliga o timer de
  // fallback. `sessionKey` guarda a sessão que a assinatura atual observa, para
  // reconectar quando o usuário troca de execução.
  const stream = {
    source: null,
    connected: false,
    sessionKey: null,
    supported: typeof window.EventSource === 'function',
  };

  // ---- Utilitários ----------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Ponto pulsante único do painel — o mesmo componente em "Executando agora"
  // e no card do dashboard. Sem texto: o rótulo adjacente carrega o significado.
  function liveDot() {
    const dot = el('span', 'live');
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }

  // Ícone textual (○ ● ✓ ✗): a cor e o rótulo ao lado já dizem o estado.
  function statusIcon(status, symbol) {
    const icon = el('span', `item-icon icon-${status}`, symbol || PHASE_ICONS[status] || '○');
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  function link(href, text, className) {
    const node = el('a', className, text);
    node.href = href;
    node.target = '_blank';
    node.rel = 'noopener';
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function parseIso(iso) {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  }

  function formatDuration(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined || totalSeconds < 0) return '—';
    const seconds = Math.round(totalSeconds);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}min ${String(seconds % 60).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}min`;
  }

  function formatAgo(iso) {
    const ms = parseIso(iso);
    if (ms === null) return '';
    return `há ${formatDuration((Date.now() - ms) / 1000)}`;
  }

  function formatClock(iso) {
    const ms = parseIso(iso);
    if (ms === null) return '';
    return new Date(ms).toLocaleTimeString('pt-BR');
  }

  // ---- Métricas (tokens e custo) --------------------------------------------
  // session.json antigo não tem os campos; os novos podem vir null. Os dois
  // casos significam "não informado" e nunca devem virar 0/NaN na tela.

  function metric(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  // 1523 → 1.5k, 2400000 → 2.4M (mesma regra do resumo no terminal).
  function compactTokens(value) {
    const abs = Math.abs(value);
    if (abs >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(Math.round(value));
  }

  // Custos abaixo de um centavo perderiam todo o significado com 2 casas.
  function formatCost(value, approximate) {
    const prefix = approximate === false ? '$' : '~$';
    return prefix + (Math.abs(value) < 0.01 ? value.toFixed(4) : value.toFixed(2));
  }

  // Ex.: '12.4k in / 3.1k out · 88.0k cache · ~$0.42'. Segmentos sem dado são
  // omitidos; sem dado algum devolve '' — sinal para não renderizar nada.
  function formatUsage(usage) {
    if (!usage) return '';
    const segments = [];

    const input = metric(usage.inputTokens);
    const output = metric(usage.outputTokens);
    const io = [];
    if (input !== null) io.push(`${compactTokens(input)} in`);
    if (output !== null) io.push(`${compactTokens(output)} out`);
    if (io.length > 0) segments.push(io.join(' / '));

    const cacheRead = metric(usage.cacheReadTokens);
    const cacheCreation = metric(usage.cacheCreationTokens);
    if (cacheRead !== null || cacheCreation !== null) {
      segments.push(`${compactTokens((cacheRead || 0) + (cacheCreation || 0))} cache`);
    }

    const cost = metric(usage.costUsd);
    if (cost !== null) segments.push(formatCost(cost));

    return segments.join(' · ');
  }

  // O agregado da issue usa nomes próprios (total*); traduz para o formato
  // comum antes de formatar.
  function formatTotals(metrics) {
    if (!metrics) return '';
    return formatUsage({
      inputTokens: metrics.totalInputTokens,
      outputTokens: metrics.totalOutputTokens,
      cacheReadTokens: metrics.totalCacheReadTokens,
      cacheCreationTokens: metrics.totalCacheCreationTokens,
      costUsd: metrics.totalCostUsd,
    });
  }

  // Duração + métricas no mesmo slot .item-side, unidos por ' · '.
  function itemSideText(parts) {
    return parts.filter((part) => part).join(' · ');
  }

  // URL do repositório derivada da URL da issue (…/issues/N → raiz do repo).
  function repoUrl(snapshot) {
    const url = snapshot.issue?.url;
    if (!url) return null;
    const match = url.match(/^(https?:\/\/\S+?)\/issues\/\d+\/?$/);
    return match ? match[1] : null;
  }

  // ---- Camada de leitura das stories ----------------------------------------
  // Único ponto de acesso a uma story individual: o Kanban e o drawer nunca
  // varrem snapshot.stories por conta própria. Quando a escrita existir, é aqui
  // que a leitura passa a conversar com ela, sem tocar na UI.

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  // Normaliza os campos que um session.json anterior pode não ter gravado, para
  // que nenhum consumidor precise repetir a checagem de ausência.
  function normalizeStory(story) {
    const status = story.status !== null && story.status !== undefined ? story.status : 'backlog';
    const stage = story.stage !== null && story.stage !== undefined ? story.stage : 'pending';
    return {
      ...story,
      status: STORY_STATUS_LABELS[status] !== undefined ? status : 'backlog',
      stage: STORY_STAGE_LABELS[stage] !== undefined ? stage : 'pending',
      stageSince:
        story.stageSince !== null && story.stageSince !== undefined ? story.stageSince : null,
      stageDetail:
        story.stageDetail !== null && story.stageDetail !== undefined ? story.stageDetail : null,
      dependencies: list(story.dependencies),
      description: text(story.description),
      acceptanceCriteria: list(story.acceptanceCriteria),
    };
  }

  function getStoryById(snapshot, id) {
    if (!snapshot) return null;
    const stories = list(snapshot.stories);
    for (const story of stories) {
      if (story.id === id) return normalizeStory(story);
    }
    return null;
  }

  function getStories(snapshot) {
    if (!snapshot) return [];
    return list(snapshot.stories).map(normalizeStory);
  }

  // ---- Abas -----------------------------------------------------------------
  // Troca apenas visibilidade e estado ARIA. Não toca no polling: render()
  // segue atualizando os dois painéis, então a aba inativa nunca fica defasada.

  function setActiveTab(tabId, options) {
    state.activeTab = tabId;
    let focused = null;
    for (const tab of els.tabs) {
      const active = tab.id === tabId;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      tab.classList.toggle('is-active', active);
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
      if (active) focused = tab;
    }
    if (options?.focus && focused) focused.focus();
  }

  // Padrão ARIA de tablist: setas movem entre as abas, Home/End vão às pontas.
  // Só a aba ativa fica no fluxo do Tab (roving tabindex).
  function onTabListKeydown(event) {
    const current = els.tabs.indexOf(event.target);
    if (current === -1) return;
    let next = -1;
    if (event.key === 'ArrowRight') next = (current + 1) % els.tabs.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + els.tabs.length) % els.tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = els.tabs.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(els.tabs[next].id, { focus: true });
  }

  // ---- Tema ------------------------------------------------------------------
  // Três estados: 'system' segue o SO (o @media decide), 'light'/'dark' forçam.
  // Quem pinta é o CSS; aqui só se define (ou remove) o data-theme da raiz.

  // Par ler/gravar tolerante a exceção, na mesma forma de readStoredRefresh()
  // e storeRefresh(): armazenamento bloqueado (janela privada, cookies de
  // terceiros desligados) não pode derrubar o painel.
  function readStoredTheme() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch (_err) {
      // localStorage indisponível (ex.: bloqueado) — segue no modo sistema.
    }
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  }

  function storeTheme(value) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch (_err) {
      // Persistência é conveniência; falha é ignorada. Sem gravar, a escolha
      // continua valendo nesta aba — só não sobrevive ao reload.
    }
  }

  function applyTheme(theme) {
    // 'system' **remove** o atributo em vez de gravar 'system': é a ausência
    // do data-theme que devolve a decisão ao @media (prefers-color-scheme).
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  // Os dois headers têm o seu seletor; mudar num precisa refletir no outro.
  // As três opções são estáticas no HTML — aqui só se sincroniza o .value.
  function syncThemeSelects() {
    if (els.themeSelect) els.themeSelect.value = state.theme;
    if (els.themeSelectDashboard) els.themeSelectDashboard.value = state.theme;
  }

  // Preferência do SO. Só se observa no modo 'system': é ali que a troca de
  // claro para escuro no SO precisa chegar ao painel com a página aberta.
  const systemThemeQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

  function onSystemThemeChange() {
    // Sincroniza o lado JS do tema com a preferência nova do SO: a raiz (que
    // no modo sistema segue sem data-theme, para o @media decidir) e o .value
    // dos dois seletores. O repaint das cores é do próprio @media, que o
    // navegador reavalia sozinho — por isso não há nada a pintar aqui.
    applyTheme(state.theme);
    syncThemeSelects();
  }

  // Anexa no modo 'system' e desanexa nos modos forçados: com tema forçado a
  // preferência do SO não vale, e continuar ouvindo seria ruído.
  function watchSystemTheme(enabled) {
    if (!systemThemeQuery) return;
    if (enabled) systemThemeQuery.addEventListener('change', onSystemThemeChange);
    else systemThemeQuery.removeEventListener('change', onSystemThemeChange);
  }

  function setTheme(theme) {
    state.theme = theme === 'light' || theme === 'dark' ? theme : 'system';
    applyTheme(state.theme);
    syncThemeSelects();
    watchSystemTheme(state.theme === 'system');
  }

  function initTheme() {
    // O <script> inline do <head> já leu a mesma chave e aplicou o tema antes
    // do primeiro paint; esta é a segunda metade da duplicação deliberada
    // documentada em THEME_STORAGE_KEY — traz a preferência para o state e,
    // com ela, para os dois seletores.
    setTheme(readStoredTheme());
  }

  // ---- Polling: intervalo configurável, aba oculta e backoff ----------------

  function readStoredRefresh() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (_err) {
      // localStorage indisponível (ex.: bloqueado) — segue com o default.
    }
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function storeRefresh(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch (_err) {
      // Persistência é conveniência; falha é ignorada.
    }
  }

  function fillRefreshSelect(select) {
    if (!select) return;
    const values = REFRESH_OPTIONS.slice();
    if (state.refreshSeconds !== PAUSED && values.indexOf(state.refreshSeconds) === -1) {
      values.push(state.refreshSeconds);
      values.sort((a, b) => a - b);
    }
    clear(select);
    for (const value of values) {
      const option = el('option', null, `${value}s`);
      option.value = String(value);
      select.appendChild(option);
    }
    const pause = el('option', null, 'pausar');
    pause.value = String(PAUSED);
    select.appendChild(pause);
    select.value = String(state.refreshSeconds);
  }

  function buildRefreshSelect() {
    fillRefreshSelect(els.refreshSelect);
    fillRefreshSelect(els.refreshSelectDashboard);
  }

  function clearTimer() {
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function schedule() {
    clearTimer();
    // Com o stream vivo, o servidor avisa: um timer aqui só repetiria trabalho.
    if (stream.connected) return;
    if (document.hidden || state.refreshSeconds === PAUSED) return;
    const base = state.refreshSeconds * 1000;
    const backoff = base * 2 ** Math.min(state.failures, 5);
    state.timer = window.setTimeout(poll, Math.min(backoff, MAX_BACKOFF_MS));
  }

  // Decide dashboard vs detalhe a partir de /api/sessions. selectedSessionId
  // null = automático; string = escolha explícita do usuário (card).
  function resolveView(sessions) {
    state.sessions = sessions;

    if (state.selectedSessionId !== null) {
      const stillThere = sessions.some((s) => s.sessionId === state.selectedSessionId);
      if (!stillThere) {
        state.selectedSessionId = null;
        state.etag = null;
      }
    }

    if (state.selectedSessionId !== null) {
      const selected = sessions.find((s) => s.sessionId === state.selectedSessionId);
      return { mode: 'detail', session: selected || null };
    }

    if (sessions.length === 0) {
      return { mode: 'detail', session: null };
    }

    if (sessions.length === 1) {
      return { mode: 'detail', session: sessions[0] };
    }

    return { mode: 'dashboard', session: null };
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    els.viewDashboard.hidden = mode !== 'dashboard';
    els.viewDetail.hidden = mode !== 'detail';
    // Back quando o usuário escolheu um card e existe uma lista para voltar.
    const showBack =
      mode === 'detail' && state.selectedSessionId !== null && state.sessions.length >= 1;
    els.backToDashboard.hidden = !showBack;
    if (mode === 'dashboard' && state.selectedDetail !== null) {
      closeDrawer();
    }
  }

  function statusUrlFor(session) {
    if (!session?.statusUrl) return 'api/status';
    // statusUrl vem com barra inicial (/api/status?session=…); o fetch relativo
    // ao path do painel precisa da forma sem a barra absoluta do host.
    return session.statusUrl.replace(/^\//, '');
  }

  function eventsUrlFor(session) {
    if (!session?.eventsUrl) return null;
    return session.eventsUrl.replace(/^\//, '');
  }

  function clearDetailState() {
    state.etag = null;
    state.snapshot = null;
    state.detailSessionId = null;
    state.events = [];
    state.diagnostics = [];
    state.eventsUrl = null;
  }

  // A versão exibida no header é a do processo que serviu esta página, nunca a
  // da CLI que iniciou a execução: os assets vivem na memória desse processo,
  // então é ela que explica o que está na tela. As duas aparecem juntas no card
  // de configuração quando divergem.
  function renderMonitorVersion(version) {
    const label = typeof version === 'string' && version !== '' ? `v${version}` : null;
    state.monitorVersion = label === null ? null : version;
    for (const node of [els.appVersion, els.appVersionDashboard]) {
      if (!node) continue;
      node.textContent = label || '';
      node.title = label === null ? '' : 'Versão do monitor que serve este painel';
      node.hidden = label === null;
    }
  }

  function serverInstanceChanged(response) {
    const instanceId = response.headers.get('X-Issue-Flow-Instance');
    if (!instanceId) return false; // servidor anterior à identidade de instância
    if (state.serverInstanceId === null) {
      state.serverInstanceId = instanceId;
      return false;
    }
    if (state.serverInstanceId !== instanceId) {
      window.location.reload();
      return true;
    }
    return false;
  }

  function streamUrl() {
    return state.detailSessionId
      ? `api/stream?session=${encodeURIComponent(state.detailSessionId)}`
      : 'api/stream';
  }

  function disconnectStream() {
    if (stream.source !== null) {
      stream.source.close();
      stream.source = null;
    }
    stream.connected = false;
    stream.sessionKey = null;
  }

  // Uma assinatura, um caminho de atualização: o frame não é aplicado
  // diretamente na tela, ele acorda o mesmo poll() que o fallback usa. Ter duas
  // rotinas de render — uma para o push, outra para o fetch — seria a segunda
  // implementação da mesma responsabilidade, e é justamente onde as duas
  // divergem sem ninguém perceber.
  function connectStream() {
    disconnectStream();
    if (!stream.supported || state.refreshSeconds === PAUSED) return;
    let source;
    try {
      source = new EventSource(streamUrl());
    } catch (_err) {
      return; // Sem push: o timer de fallback continua valendo.
    }
    stream.source = source;
    stream.sessionKey = state.detailSessionId;

    source.addEventListener('hello', () => {
      stream.connected = true;
      state.failures = 0;
      els.banner.hidden = true;
      clearTimer();
    });

    const wake = () => {
      if (document.hidden) return;
      requestPoll();
    };
    source.addEventListener('sessions', wake);
    source.addEventListener('status', wake);
    source.addEventListener('gone', wake);

    source.onerror = () => {
      // O EventSource reconecta sozinho; até lá o intervalo volta a valer, e é
      // por isso que o seletor de refresh não desaparece da interface.
      stream.connected = false;
      schedule();
    };
  }

  // A assinatura acompanha a sessão em foco: um `status` só chega para a
  // sessão pedida no handshake.
  function syncStreamSubscription() {
    if (!stream.supported || state.refreshSeconds === PAUSED) return;
    if (stream.source !== null && stream.sessionKey === state.detailSessionId) return;
    connectStream();
  }

  function requestPoll() {
    clearTimer();
    if (state.polling) {
      state.pollAgain = true;
      return;
    }
    poll();
  }

  function selectSession(sessionId) {
    if (state.selectedSessionId !== sessionId) {
      clearDetailState();
    }
    state.selectedSessionId = sessionId;
    requestPoll();
  }

  function clearSessionSelection() {
    state.selectedSessionId = null;
    clearDetailState();
    requestPoll();
  }

  async function poll() {
    if (state.polling) {
      state.pollAgain = true;
      return;
    }
    state.polling = true;
    state.pollAgain = false;
    try {
      const sessionsRes = await fetch('api/sessions', { cache: 'no-store' });
      if (serverInstanceChanged(sessionsRes)) return;
      if (!sessionsRes.ok) throw new Error(`HTTP ${sessionsRes.status}`);
      const sessions = await sessionsRes.json();
      if (!Array.isArray(sessions)) throw new Error('sessions payload invalid');

      const resolved = resolveView(sessions);

      if (resolved.mode === 'dashboard') {
        clearDetailState();
        setViewMode('dashboard');
        renderDashboard(sessions);
        state.failures = 0;
        els.banner.hidden = true;
        return;
      }

      const nextId =
        resolved.session && resolved.session.sessionId != null ? resolved.session.sessionId : null;
      const sessionChanged = state.detailSessionId !== nextId;
      if (sessionChanged) {
        clearDetailState();
        state.detailSessionId = nextId;
      }

      if (!resolved.session) {
        setViewMode('detail');
        // Zero sessões: mantém a última tela de detalhe se houver, sem explodir.
        renderEmptyDetail();
        state.failures = 0;
        els.banner.hidden = true;
        return;
      }

      const nextUrl = statusUrlFor(resolved.session);
      if (nextUrl !== state.statusUrl) {
        state.statusUrl = nextUrl;
        state.etag = null;
      }
      state.eventsUrl = eventsUrlFor(resolved.session);

      // Evita flash da sessão anterior enquanto o status novo carrega.
      if (sessionChanged || !state.snapshot) {
        els.viewDashboard.hidden = true;
        els.viewDetail.hidden = true;
      } else {
        setViewMode('detail');
      }

      const headers = {};
      if (state.etag) headers['If-None-Match'] = state.etag;
      const res = await fetch(state.statusUrl, { headers, cache: 'no-store' });
      // Se selectSession/clear pediu outro poll no meio do fetch, descarta este
      // status — o ciclo seguinte aplica a seleção atual.
      if (state.pollAgain) {
        state.failures = 0;
        els.banner.hidden = true;
        return;
      }
      if (res.status !== 304) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.etag = res.headers.get('ETag');
        state.snapshot = await res.json();
        render();
      }
      const configUrl = `api/config?session=${encodeURIComponent(state.detailSessionId || '')}`;
      const configRes = await fetch(configUrl, { cache: 'no-store' });
      if (configRes.ok) {
        state.configData = await configRes.json();
        if (state.snapshot) renderConfiguration(state.snapshot);
      }
      if (state.eventsUrl) {
        const eventsRes = await fetch(state.eventsUrl, { cache: 'no-store' });
        if (!eventsRes.ok) throw new Error(`HTTP ${eventsRes.status}`);
        const entries = await eventsRes.json();
        state.events = Array.isArray(entries) ? entries : [];
        const diagnosticUrl = `api/diagnostics?session=${encodeURIComponent(state.detailSessionId || '')}`;
        const diagnosticsRes = await fetch(diagnosticUrl, { cache: 'no-store' });
        if (diagnosticsRes.ok) {
          const diagnostics = await diagnosticsRes.json();
          state.diagnostics = Array.isArray(diagnostics) ? diagnostics : [];
        }
        renderHistory();
        renderDrawer(state.snapshot);
      }
      setViewMode('detail');
      state.failures = 0;
      els.banner.hidden = true;
    } catch (_err) {
      state.failures += 1;
      els.banner.hidden = false;
    } finally {
      state.polling = false;
      if (state.pollAgain) {
        state.pollAgain = false;
        poll();
      } else {
        syncStreamSubscription();
        schedule();
      }
    }
  }

  function renderEmptyDetail() {
    if (state.snapshot) return;
    document.title = 'issue-flow';
    els.issueLink.hidden = true;
    els.issueHeadline.textContent = 'Nenhuma execução ativa';
    els.branchLine.textContent = '';
    els.statusBadge.textContent = STATUS_LABELS.idle;
    els.statusBadge.className = 'badge status-idle';
    els.elapsed.textContent = '—';
    els.estimate.hidden = true;
    els.sessionMeta.textContent = 'nenhuma execução ativa';
  }

  function truncateText(text, max) {
    if (!text) return '';
    const normalized = String(text).replace(/\s+/g, ' ').trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 1).trimEnd()}…`;
  }

  // Linha secundária do header do dashboard: quantas execuções e em que
  // estado. Substitui a legenda estática que só repetia o h1.
  function renderDashboardSummary(sessions) {
    const counts = {};
    for (const session of sessions) {
      const status = session.status || 'idle';
      counts[status] = (counts[status] || 0) + 1;
    }
    const parts = [];
    for (const status of SUMMARY_STATUS_ORDER) {
      const count = counts[status];
      if (!count) continue;
      const label = SUMMARY_STATUS_LABELS[status];
      parts.push(`${count} ${count === 1 ? label[0] : label[1]}`);
    }
    const total = sessions.length + (sessions.length === 1 ? ' execução' : ' execuções');
    els.dashboardSummary.textContent = parts.length > 0 ? `${total} · ${parts.join(' · ')}` : total;
  }

  function renderDashboard(sessions) {
    const active = document.activeElement;
    const focusedId =
      active?.dataset && els.dashboard.contains(active) && active.dataset.sessionId
        ? active.dataset.sessionId
        : null;

    clear(els.dashboard);

    if (sessions.length === 0) {
      els.dashboard.appendChild(el('p', 'empty', 'Nenhuma execução ativa.'));
      els.dashboardMeta.textContent = '0 execuções';
      els.dashboardSummary.textContent = 'Nenhuma execução ativa';
      document.title = 'issue-flow';
      return;
    }

    renderDashboardSummary(sessions);

    for (const session of sessions) {
      // <button> só aceita phrasing content — mesmos spans do Kanban.
      const card = el('button', 'dashboard-card');
      card.type = 'button';
      if (session.sessionId) card.dataset.sessionId = session.sessionId;
      if (session.status === 'running') card.classList.add('is-live');

      const head = el('span', 'dashboard-card-head');
      const project = el(
        'span',
        'dashboard-project',
        session.repositoryName || 'Projeto desconhecido',
      );
      const badge = el('span', `badge status-${session.status || 'idle'}`);
      badge.textContent = STATUS_LABELS[session.status] || session.status || '—';
      head.appendChild(project);
      head.appendChild(badge);
      card.appendChild(head);

      const titleRow = el('span', 'dashboard-title-row');
      if (session.issueNumber !== null && session.issueNumber !== undefined) {
        titleRow.appendChild(el('span', 'dashboard-issue', `#${session.issueNumber}`));
      }
      titleRow.appendChild(el('span', 'dashboard-title', session.issueTitle || 'Sem título'));
      card.appendChild(titleRow);

      const summary = truncateText(session.issueDescription, DESCRIPTION_PREVIEW);
      card.appendChild(el('span', 'dashboard-summary muted', summary || 'Sem descrição'));

      const meta = el('span', 'dashboard-meta-row');
      meta.appendChild(el('span', null, `Fase: ${session.currentPhase || '—'}`));
      const percent = typeof session.progressPercent === 'number' ? session.progressPercent : 0;
      meta.appendChild(el('span', null, `${percent}%`));
      const elapsed =
        typeof session.elapsedSeconds === 'number'
          ? formatDuration(session.elapsedSeconds)
          : session.startedAt
            ? formatAgo(session.startedAt)
            : '—';
      meta.appendChild(el('span', null, elapsed));
      // Resilience: how hard this run has had to work, and when it last moved.
      // A card that only shows a percentage cannot tell a run that is
      // progressing from one that has been retrying for twenty minutes.
      if (typeof session.retries === 'number' && session.retries > 0) {
        meta.appendChild(el('span', null, `${session.retries} retry(s)`));
      }
      if (typeof session.correctionCycle === 'number' && session.correctionCycle > 0) {
        meta.appendChild(el('span', null, `correção ${session.correctionCycle}`));
      }
      if (session.updatedAt) {
        meta.appendChild(
          el('span', null, `atividade ${formatAgo(session.lastActivityAt || session.updatedAt)}`),
        );
      }
      if (session.provider) meta.appendChild(el('span', null, `provider ${session.provider}`));
      if (typeof session.attempt === 'number' && session.attempt > 0) {
        meta.appendChild(el('span', null, `tentativa ${session.attempt}`));
      }
      card.appendChild(meta);

      const progress = el('span', 'dashboard-progress');
      const bar = el('span', 'dashboard-progress-bar');
      bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      progress.appendChild(bar);
      card.appendChild(progress);

      if (session.status === 'running') {
        const live = el('span', 'live-label');
        live.appendChild(liveDot());
        live.appendChild(document.createTextNode('ao vivo'));
        card.appendChild(live);
      }

      card.addEventListener('click', () => {
        if (session.sessionId) selectSession(session.sessionId);
      });

      els.dashboard.appendChild(card);
    }

    els.dashboardMeta.textContent =
      sessions.length + (sessions.length === 1 ? ' execução' : ' execuções');
    document.title = `${sessions.length} execuções · issue-flow`;

    if (focusedId) {
      const card = els.dashboard.querySelector(
        `[data-session-id="${focusedId.replace(/"/g, '')}"]`,
      );
      if (card) card.focus();
    }
  }

  // ---- Renderização ---------------------------------------------------------

  function render() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    renderHeader(snapshot);
    renderAlerts(snapshot);
    renderIssueSummary(snapshot);
    renderRepository(snapshot);
    renderProgress(snapshot);
    renderNow(snapshot);
    renderResilience(snapshot);
    renderConfiguration(snapshot);
    renderPhases(snapshot);
    renderNextSteps(snapshot);
    renderStories(snapshot);
    // Incondicional: a aba inativa não pode ficar defasada até ser aberta.
    renderKanban(snapshot);
    renderDrawer(snapshot);
    renderGit(snapshot);
    renderLogs(snapshot);
    renderHistory();
    renderMeta(snapshot);
    renderTimers();
    renderTitle(snapshot);
  }

  function renderTitle(snapshot) {
    const issue = snapshot.issue.number !== null ? `#${snapshot.issue.number}` : '';
    let prefix = '';
    if (snapshot.status === 'running') prefix = `${snapshot.progress.percent}% · `;
    else if (snapshot.status === 'completed') prefix = '✓ ';
    else if (snapshot.status === 'failed') prefix = '✗ ';
    document.title = `${prefix + issue} · issue-flow`.replace(/^ · /, '');
  }

  // O h1 é a execução — número, título, e ao lado status, tempo decorrido e
  // branch. A marca do produto vive só no <title> do documento.
  function renderHeader(snapshot) {
    const hasIssue = snapshot.issue.number !== null && snapshot.issue.number !== undefined;
    if (hasIssue) {
      els.issueLink.hidden = false;
      els.issueLink.textContent = `#${snapshot.issue.number}`;
      if (snapshot.issue.url) els.issueLink.href = snapshot.issue.url;
      else els.issueLink.removeAttribute('href');
    } else {
      els.issueLink.hidden = true;
    }

    // session.json antigo pode não ter título; sem issue vinculada, nem número.
    els.issueHeadline.textContent =
      snapshot.issue.title || (hasIssue ? 'Sem título' : 'Execução sem issue vinculada');

    const branch = snapshot.git.branch;
    const base = snapshot.git.baseBranch;
    const branchMode =
      snapshot.git.branchCreated === false
        ? 'branch atual · não criada pelo Issue Flow'
        : snapshot.git.branchCreated === true
          ? 'criada pelo Issue Flow'
          : 'origem da branch não informada';
    els.branchLine.textContent = branch
      ? `${base ? `${branch} ← ${base}` : branch} · ${branchMode}`
      : '';

    els.statusBadge.textContent = STATUS_LABELS[snapshot.status] || snapshot.status;
    els.statusBadge.className = `badge status-${snapshot.status}`;
  }

  function renderAlerts(snapshot) {
    const errors = snapshot.errors || [];
    const warnings = snapshot.warnings || [];
    const lastError = snapshot.lastError;
    const any = errors.length > 0 || warnings.length > 0 || lastError !== null;
    els.alerts.hidden = !any;
    clear(els.alertsBody);
    if (!any) return;

    const counts = [];
    if (errors.length > 0) counts.push(`${errors.length} erro(s)`);
    if (warnings.length > 0) counts.push(`${warnings.length} aviso(s)`);
    if (counts.length > 0) {
      els.alertsBody.appendChild(el('p', 'alert-count', counts.join(' · ')));
    }

    if (lastError) {
      const entry = el('div', 'alert-entry level-error');
      entry.appendChild(el('strong', null, 'Último erro: '));
      entry.appendChild(document.createTextNode(lastError.message));
      els.alertsBody.appendChild(entry);
    }
    for (const log of errors.slice(-ALERT_PREVIEW)) {
      const entry = el('div', 'alert-entry level-error');
      entry.appendChild(el('span', 'mono', `${formatClock(log.at)} `));
      entry.appendChild(document.createTextNode(log.message));
      els.alertsBody.appendChild(entry);
    }
    for (const log of warnings.slice(-ALERT_PREVIEW)) {
      const entry = el('div', 'alert-entry level-warn');
      entry.appendChild(el('span', 'mono', `${formatClock(log.at)} `));
      entry.appendChild(document.createTextNode(log.message));
      els.alertsBody.appendChild(entry);
    }
  }

  // snapshot.issue vem sempre como objeto (schema não o torna nulável); só os
  // campos individuais podem ser null/undefined — session.json antigo, issue
  // local sem remote, etc. Cada leitura abaixo trata isso individualmente.
  function renderIssueSummary(snapshot) {
    clear(els.issueSummary);
    const issue = snapshot.issue || {};

    // Número e título saem no h1 do header (renderHeader); aqui fica só o que
    // o header não carrega — estado, labels e descrição.
    const meta = el('div', 'issue-summary-meta');
    const state = issue.state || null;
    const stateClass =
      state === 'open' ? 'state-open' : state === 'closed' ? 'state-closed' : 'state-unknown';
    meta.appendChild(el('span', `badge ${stateClass}`, state || 'estado desconhecido'));
    els.issueSummary.appendChild(meta);

    const labels = issue.labels || [];
    if (labels.length > 0) {
      const labelRow = el('div', 'badge-row');
      for (const label of labels) {
        labelRow.appendChild(el('span', 'badge label-badge', label));
      }
      els.issueSummary.appendChild(labelRow);
    }

    els.issueSummary.appendChild(
      el('p', 'issue-description', issue.description || 'Sem descrição.'),
    );
  }

  function metaRow(grid, label, value, className) {
    grid.appendChild(el('dt', null, label));
    const dd = el('dd', className, value);
    grid.appendChild(dd);
    return dd;
  }

  // snapshot.repository é coletado de forma tolerante a falhas (sem remote,
  // sem commits, git ausente): cada campo pode ser null independentemente dos
  // demais, nunca o objeto inteiro.
  function renderRepository(snapshot) {
    clear(els.repository);
    const repo = snapshot.repository || {};
    const grid = el('dl', 'now-grid');
    metaRow(grid, 'Repositório', repo.name || '—');
    metaRow(grid, 'Branch', repo.branch || '—', 'mono');
    metaRow(grid, 'Commit', repo.headCommit || '—', 'mono');
    const rootDd = metaRow(grid, 'Diretório', repo.root || '—', 'mono');
    if (repo.root) rootDd.title = repo.root;
    els.repository.appendChild(grid);
  }

  function renderProgress(snapshot) {
    const progress = snapshot.progress;
    els.progressBar.value = progress.percent;
    els.progressPercent.textContent = `${progress.percent}%`;
    const counters =
      'Fases ' +
      progress.phasesCompleted +
      '/' +
      progress.phasesTotal +
      ' · Stories ' +
      progress.storiesCompleted +
      '/' +
      progress.storiesTotal;
    const totals = formatTotals(snapshot.metrics);
    els.progressCounters.textContent = totals ? `${counters} · ${totals}` : counters;
  }

  function nowRow(grid, label, value) {
    grid.appendChild(el('dt', null, label));
    grid.appendChild(el('dd', null, value));
  }

  function renderNow(snapshot) {
    clear(els.now);
    if (snapshot.status !== 'running') {
      const messages = {
        idle: 'Nenhuma execução em andamento.',
        completed: 'Execução concluída.',
        failed: 'Execução falhou. Veja os erros acima.',
      };
      els.now.appendChild(el('p', 'empty', messages[snapshot.status] || '—'));
      return;
    }

    const grid = el('dl', 'now-grid');
    const phase = el('dd', 'now-phase');
    if (snapshot.currentPhase) {
      phase.appendChild(liveDot());
      phase.appendChild(document.createTextNode(snapshot.currentPhase));
    } else {
      phase.textContent = '—';
    }
    grid.appendChild(el('dt', null, 'Fase'));
    grid.appendChild(phase);

    const activity = snapshot.currentActivity;
    if (activity) {
      if (activity.story) nowRow(grid, 'User story', activity.story);
      if (activity.tool) nowRow(grid, 'Ferramenta', activity.tool);
      if (activity.detail) nowRow(grid, 'Detalhe', activity.detail);
      const since = el('dd', null, formatAgo(activity.since));
      since.dataset.since = activity.since;
      grid.appendChild(el('dt', null, 'Há quanto tempo'));
      grid.appendChild(since);
    }
    els.now.appendChild(grid);
  }

  function renderResilience(snapshot) {
    clear(els.resilience);
    const resilience = snapshot.resilience || {};
    const grid = el('dl', 'now-grid');
    nowRow(grid, 'Tentativa', resilience.attempt > 0 ? String(resilience.attempt) : '—');
    nowRow(grid, 'Provider', resilience.provider || '—');
    nowRow(grid, 'Modelo', resilience.model || '—');
    nowRow(grid, 'Última falha', resilience.lastFailureKind || '—');
    nowRow(
      grid,
      'Cooldown',
      resilience.cooldownUntil ? formatClock(resilience.cooldownUntil) : '—',
    );
    const activity = resilience.lastActivityAt
      ? `${formatClock(resilience.lastActivityAt)} (${formatAgo(resilience.lastActivityAt)})`
      : '—';
    nowRow(grid, 'Última atividade', activity);
    els.resilience.appendChild(grid);
  }

  function configSourceLabel(source) {
    const labels = {
      default: 'default do Issue Flow',
      global: 'configuração global',
      project: 'configuração do projeto',
      env: 'variável de ambiente',
      cli: 'override da execução',
      fallback: 'fallback',
      recommended: 'política recomendada',
    };
    return labels[source] || source || 'não informado';
  }

  function renderConfiguration(snapshot) {
    clear(els.configuration);

    // Quem executou e quem está mostrando. São processos diferentes e podem
    // estar em versões diferentes; este é o único lugar onde as duas aparecem
    // lado a lado, então a divergência é dita aqui.
    const env = snapshot.environment;
    const runVersion = env?.cliVersion ? env.cliVersion : null;
    const runtime = el('dl', 'now-grid');
    const runtimeBits = [runVersion ? `v${runVersion}` : 'versão não registrada'];
    if (env?.node) runtimeBits.push(env.node);
    if (env?.platform) runtimeBits.push(env.platform);
    nowRow(runtime, 'Issue Flow (execução)', runtimeBits.join(' · '));
    nowRow(
      runtime,
      'Monitor (este painel)',
      state.monitorVersion ? `v${state.monitorVersion}` : '—',
    );
    els.configuration.appendChild(runtime);
    if (runVersion !== null && state.monitorVersion && runVersion !== state.monitorVersion) {
      els.configuration.appendChild(
        el(
          'p',
          'alert-entry level-warn',
          'Este painel é servido por uma versão diferente da que executa o pipeline. ' +
            'Reinicie o monitor com --restart-web para ver a interface desta versão.',
        ),
      );
    }

    const config = snapshot.configuration;
    if (!config) {
      els.configuration.appendChild(el('p', 'empty', 'Configuração não capturada nesta execução.'));
      return;
    }

    const summary = el('dl', 'now-grid');
    nowRow(
      summary,
      'Harness padrão',
      (config.defaultProvider.value || '—') +
        ' · ' +
        configSourceLabel(config.defaultProvider.source),
    );
    nowRow(
      summary,
      'Modelo padrão',
      (config.defaultModel.value || 'default do provider') +
        ' · ' +
        configSourceLabel(config.defaultModel.source),
    );
    nowRow(summary, 'Fallbacks', list(config.fallbacks).join(' → ') || 'nenhum configurado');
    nowRow(summary, 'Precedência', list(config.precedence).join(' → '));
    els.configuration.appendChild(summary);

    const liveRouting = state.configData?.routing;
    if (liveRouting) {
      const routingSummary = el('dl', 'now-grid config-routing-summary');
      nowRow(routingSummary, 'Routing', `${liveRouting.mode} · perfil ${liveRouting.profile}`);
      nowRow(
        routingSummary,
        'Política',
        liveRouting.policy === 'recommended' ? 'recomendada (opt-in)' : 'score adaptativo',
      );
      els.configuration.appendChild(routingSummary);

      if (state.configWritable) {
        const routingForm = el('form', 'config-form config-routing-form');
        const mode = el('select');
        mode.setAttribute('aria-label', 'Modo de routing');
        for (const value of ['off', 'shadow', 'recommend', 'active']) {
          const option = el('option', null, value);
          option.value = value;
          mode.appendChild(option);
        }
        mode.value = liveRouting.mode;
        const profile = el('select');
        profile.setAttribute('aria-label', 'Perfil de routing');
        for (const value of ['economy', 'balanced', 'quality', 'speed']) {
          const option = el('option', null, value);
          option.value = value;
          profile.appendChild(option);
        }
        profile.value = liveRouting.profile;
        const saveRouting = el('button', 'config-save', 'Salvar routing');
        saveRouting.type = 'submit';
        const applyPolicy = el(
          'button',
          'config-save config-policy',
          'Aplicar política recomendada',
        );
        applyPolicy.type = 'button';
        const routingFeedback = el('span', 'muted');
        routingForm.appendChild(mode);
        routingForm.appendChild(profile);
        routingForm.appendChild(saveRouting);
        routingForm.appendChild(applyPolicy);
        routingForm.appendChild(routingFeedback);
        routingForm.addEventListener('submit', async (event) => {
          event.preventDefault();
          await saveRoutingConfig(
            { mode: mode.value, profile: profile.value },
            saveRouting,
            routingFeedback,
          );
        });
        applyPolicy.addEventListener('click', async () => {
          await saveRoutingConfig({ policy: 'recommended' }, applyPolicy, routingFeedback);
        });
        els.configuration.appendChild(routingForm);
      }
    }

    const phases = el('div', 'config-phase-grid');
    for (const phase of list(config.phases)) {
      const row = el(state.configWritable ? 'form' : 'button', 'config-phase-row');
      if (!state.configWritable) row.type = 'button';
      if (state.configWritable) {
        row.classList.add('is-editable');
        const phaseButton = el('button', 'config-phase-open mono', phase.phase);
        phaseButton.type = 'button';
        phaseButton.addEventListener('click', () => openDrawer('phase', phase.phase));
        row.appendChild(phaseButton);
        const provider = el('select');
        provider.setAttribute('aria-label', `Harness para ${phase.phase}`);
        fillProviderSelect(provider, phase.provider.value || 'claude');
        const model = el('select');
        model.setAttribute('aria-label', `Tier e modelo para ${phase.phase}`);
        fillModelSelect(model, provider.value, phase.model.value || '');
        provider.addEventListener('change', () => fillModelSelect(model, provider.value, ''));
        const save = el('button', 'config-save', 'Salvar');
        save.type = 'submit';
        const feedback = el('span', 'muted config-phase-feedback');
        row.appendChild(provider);
        row.appendChild(model);
        row.appendChild(save);
        row.appendChild(feedback);
        row.addEventListener('submit', async (event) => {
          event.preventDefault();
          save.disabled = true;
          feedback.textContent = 'salvando…';
          try {
            const response = await fetch('api/config/agent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                provider: provider.value,
                model: model.value,
                phase: phase.phase,
              }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'falha ao salvar');
            feedback.textContent = 'salvo para a próxima execução';
          } catch (error) {
            feedback.textContent = error.message || 'falha ao salvar';
          } finally {
            save.disabled = false;
          }
        });
      } else {
        row.appendChild(el('span', 'mono', phase.phase));
        row.appendChild(el('span', null, phase.provider.value || '—'));
        row.appendChild(el('span', null, phase.model.value || 'default do provider'));
        row.appendChild(
          el(
            'span',
            'muted',
            configSourceLabel(phase.provider.source) +
              ' / ' +
              configSourceLabel(phase.model.source),
          ),
        );
        row.addEventListener('click', () => openDrawer('phase', phase.phase));
      }
      phases.appendChild(row);
    }
    els.configuration.appendChild(phases);

    const form = el('form', 'config-form');
    const provider = el('select');
    provider.setAttribute('aria-label', 'Harness padrão para execuções futuras');
    for (const id of ['claude', 'codex', 'cursor', 'antigravity', 'opencode']) {
      const option = el('option', null, id);
      option.value = id;
      provider.appendChild(option);
    }
    provider.value = config.defaultProvider.value || 'claude';
    const model = el('input');
    model.type = 'text';
    model.placeholder = 'modelo (vazio = default)';
    model.value = config.defaultModel.value || '';
    const save = el('button', 'config-save', 'Salvar preferência global');
    save.type = 'submit';
    const feedback = el('span', 'muted');
    form.appendChild(provider);
    form.appendChild(model);
    form.appendChild(save);
    form.appendChild(feedback);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      feedback.textContent = 'salvando…';
      try {
        const response = await fetch('api/config/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: provider.value, model: model.value }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'falha ao salvar');
        feedback.textContent = 'salvo para execuções futuras';
      } catch (error) {
        feedback.textContent = error.message || 'falha ao salvar';
      } finally {
        save.disabled = false;
      }
    });
    form.hidden = !state.configWritable;
    els.configuration.appendChild(form);
  }

  function catalog() {
    return list(state.configData?.catalog);
  }

  function fillProviderSelect(select, selected) {
    clear(select);
    const entries = catalog().filter((entry) => {
      if (!entry.installed) return false;
      if (entry.state === 'unavailable') return false;
      if (entry.authentication === 'failed') return false;
      return (
        entry.authenticated !== false || entry.state === 'conditional' || entry.state === 'ready'
      );
    });
    const providers = entries.length
      ? entries.map((entry) => entry.provider)
      : ['claude', 'codex', 'cursor', 'antigravity', 'opencode'];
    if (!providers.includes(selected)) providers.push(selected);
    for (const provider of providers) {
      const option = el('option', null, provider);
      option.value = provider;
      select.appendChild(option);
    }
    select.value = selected;
  }

  function fillModelSelect(select, provider, selected) {
    clear(select);
    const defaultOption = el('option', null, 'default do provider');
    defaultOption.value = '';
    select.appendChild(defaultOption);
    const entry = catalog().find((candidate) => candidate.provider === provider);
    for (const model of list(entry?.models)) {
      if (!model.id) continue;
      const option = el('option', null, `${model.tier} · ${model.id}`);
      option.value = model.id;
      select.appendChild(option);
    }
    if (
      selected &&
      !Array.prototype.some.call(select.options, (option) => option.value === selected)
    ) {
      const current = el('option', null, `configurado · ${selected}`);
      current.value = selected;
      select.appendChild(current);
    }
    select.value = selected || '';
  }

  async function saveRoutingConfig(values, button, feedback) {
    button.disabled = true;
    feedback.textContent = 'salvando…';
    try {
      const response = await fetch('api/config/routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'falha ao salvar');
      state.configData.routing = Object.assign({}, state.configData.routing, values);
      feedback.textContent = 'salvo para execuções futuras';
    } catch (error) {
      feedback.textContent = error.message || 'falha ao salvar';
    } finally {
      button.disabled = false;
    }
  }

  function renderPhases(snapshot) {
    clear(els.phases);
    if (snapshot.phases.length === 0) {
      els.phases.appendChild(el('p', 'empty', 'Nenhuma fase registrada ainda.'));
      return;
    }
    for (const phase of snapshot.phases) {
      const item = el('li');
      item.className = 'detail-row';
      item.appendChild(statusIcon(phase.status));
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-title', phase.name));
      if (phase.error) main.appendChild(el('div', 'item-error', phase.error));
      item.appendChild(main);
      const duration = metric(phase.durationSeconds);
      const side = itemSideText([
        duration !== null ? formatDuration(duration) : '',
        formatUsage(phase),
      ]);
      if (side) item.appendChild(el('span', 'item-side', side));
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.addEventListener('click', () => openDrawer('phase', phase.name));
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') openDrawer('phase', phase.name);
      });
      els.phases.appendChild(item);
    }
  }

  // Uma linha dentro do bloco de estado, não uma lista num cartão próprio: os
  // passos são poucos e curtos, e o rótulo já vem do HTML (.next-steps-label).
  function renderNextSteps(snapshot) {
    clear(els.nextSteps);
    if (snapshot.nextSteps.length === 0) {
      const message =
        snapshot.status === 'completed' ? 'Pipeline concluído.' : 'Nenhum passo pendente.';
      els.nextSteps.appendChild(el('span', 'empty', message));
      return;
    }
    els.nextSteps.appendChild(el('span', null, snapshot.nextSteps.join(' · ')));
  }

  function renderStories(snapshot) {
    clear(els.stories);
    if (snapshot.stories.length === 0) {
      els.stories.appendChild(el('p', 'empty', 'Nenhuma user story registrada ainda.'));
      return;
    }
    for (const story of snapshot.stories) {
      // stage vem com default no schema ('pending'), mas session.json gravado
      // antes da issue 38 pode chegar sem ele.
      const storyStage =
        story.stage !== null && story.stage !== undefined ? story.stage : 'pending';
      const item = el('li', storyStage === 'executing' ? 'story-executing' : null);
      item.classList.add('detail-row');
      const status = story.passes ? 'completed' : 'pending';
      item.appendChild(statusIcon(status, story.passes ? '✓' : '○'));
      const main = el('div', 'item-main');
      const title = el('div', 'item-title');
      title.appendChild(el('span', 'story-id', story.id));
      title.appendChild(document.createTextNode(story.title));
      main.appendChild(title);

      // status/dependencies vêm com default no schema (backlog/[]), mas
      // session.json gravado antes de #29 pode chegar sem eles.
      const storyStatus =
        story.status !== null && story.status !== undefined ? story.status : 'backlog';
      const meta = el('div', 'story-meta');
      meta.appendChild(
        el(
          'span',
          `badge story-status-${storyStatus}`,
          STORY_STATUS_LABELS[storyStatus] || storyStatus,
        ),
      );
      const dependencies = story.dependencies || [];
      if (dependencies.length > 0) {
        meta.appendChild(el('span', 'muted story-deps', `depende de: ${dependencies.join(', ')}`));
      }
      main.appendChild(meta);

      item.appendChild(main);
      const duration = metric(story.durationSeconds);
      const stageLabel = STORY_STAGE_LABELS[storyStage] || storyStage;
      const stageText = story.stageSince
        ? `${stageLabel} ${formatAgo(story.stageSince)}`
        : stageLabel;
      const side = itemSideText([
        stageText,
        story.completedAt ? `concluída ${formatClock(story.completedAt)}` : '',
        duration !== null ? formatDuration(duration) : '',
        formatUsage(story),
      ]);
      if (side) item.appendChild(el('span', 'item-side', side));
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.addEventListener('click', () => openDrawer('story', story.id));
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') openDrawer('story', story.id);
      });
      els.stories.appendChild(item);
    }
  }

  // As stories chegam já normalizadas por getStories(), então aqui nenhum campo
  // precisa de checagem de ausência.
  // <button> em vez de <div role="button">: acionamento por Enter/Espaço e foco
  // saem de graça. Por isso todo o conteúdo é <span> — <p>/<div> não são
  // conteúdo válido dentro de um botão.
  function storyCard(story) {
    const card = el('button', 'kanban-card');
    card.type = 'button';
    card.dataset.storyId = story.id;

    const head = el('span', 'kanban-card-head');
    head.appendChild(statusIcon(story.passes ? 'completed' : 'pending', story.passes ? '✓' : '○'));
    head.appendChild(el('span', 'story-id', story.id));
    card.appendChild(head);

    card.appendChild(el('span', 'kanban-card-title', story.title));
    if (story.description) card.appendChild(el('span', 'kanban-card-desc', story.description));
    card.appendChild(
      el('span', `badge story-status-${story.status}`, STORY_STATUS_LABELS[story.status]),
    );
    card.addEventListener('click', () => openDrawer('story', story.id));
    return card;
  }

  function renderKanban(snapshot) {
    clear(els.kanban);
    const stories = getStories(snapshot);
    for (const column of KANBAN_COLUMNS) {
      const entries = stories.filter((story) => story.status === column.status);

      const node = el('section', 'kanban-column');
      const head = el('div', 'kanban-column-head');
      head.appendChild(el('h3', 'kanban-column-title', column.title));
      head.appendChild(el('span', 'kanban-column-count', String(entries.length)));
      node.appendChild(head);

      if (entries.length === 0) {
        node.appendChild(el('p', 'empty kanban-empty', 'Nenhuma story.'));
      } else {
        for (const story of entries) node.appendChild(storyCard(story));
      }
      els.kanban.appendChild(node);
    }
  }

  // ---- Drawer de detalhes da story ------------------------------------------

  function onDrawerKeydown(event) {
    if (event.key === 'Escape') closeDrawer();
  }

  function executionsFor(snapshot, kind, id) {
    return list(snapshot.executions).filter((execution) => {
      if (kind === 'phase') return execution.purpose === id;
      return list(execution.storyIds).includes(id);
    });
  }

  function executionCost(execution) {
    const cost = execution.cost || {};
    if (cost.status === 'reported' || cost.status === 'estimated') {
      return formatCost(cost.amount, cost.status === 'estimated');
    }
    return cost.reason ? `não informado (${cost.reason})` : 'não informado';
  }

  function renderExecutionHistory(_snapshot, executions) {
    drawerSection('Tentativas, revisões e correções', (body) => {
      if (executions.length === 0) {
        body.appendChild(el('p', 'empty', 'Nenhuma invocação associada.'));
        return;
      }
      const timeline = el('ol', 'execution-timeline');
      for (const execution of executions.slice().reverse()) {
        const item = el('li', 'execution-entry');
        const title = el('div', 'execution-entry-head');
        title.appendChild(
          el(
            'span',
            `badge status-${execution.status === 'completed' ? 'completed' : execution.status}`,
            execution.status,
          ),
        );
        title.appendChild(
          el(
            'strong',
            null,
            `${execution.purpose} · tentativa ${execution.attempt} · ${execution.trigger}`,
          ),
        );
        item.appendChild(title);
        const grid = el('dl', 'now-grid execution-grid');
        nowRow(grid, 'Harness', execution.agent?.harness || '—');
        nowRow(
          grid,
          'Modelo',
          execution.agent?.model?.resolved || execution.agent?.model?.requested || '—',
        );
        nowRow(grid, 'Início', formatClock(execution.startedAt));
        nowRow(
          grid,
          'Fim',
          execution.finishedAt ? formatClock(execution.finishedAt) : 'em andamento',
        );
        nowRow(
          grid,
          'Duração',
          metric(execution.durationMs) !== null ? formatDuration(execution.durationMs / 1000) : '—',
        );
        nowRow(grid, 'Tokens', formatUsage(execution.usage || {}) || '—');
        nowRow(grid, 'Custo', executionCost(execution));
        if (execution.correctionCycle)
          nowRow(grid, 'Correção', `ciclo ${execution.correctionCycle}`);
        if (execution.verdict?.status) nowRow(grid, 'Veredito', execution.verdict.status);
        item.appendChild(grid);
        if (execution.failure?.message)
          item.appendChild(el('p', 'item-error', execution.failure.message));
        timeline.appendChild(item);
      }
      body.appendChild(timeline);
    });
  }

  function renderProcessLogs(snapshot, executions, phase) {
    const ids = new Set(executions.map((execution) => execution.id));
    const logs = list(snapshot.processLogs).filter(
      (entry) => ids.has(entry.executionId) || (ids.size === 0 && entry.phase === phase),
    );
    drawerSection('Saída do processo', (body) => {
      const details = el('details', 'process-output');
      const summary = el('summary', null, `${logs.length} linha(s) sanitizada(s)`);
      details.appendChild(summary);
      if (logs.length === 0) {
        details.appendChild(el('p', 'empty', 'Nenhuma saída capturada.'));
      } else {
        const output = el('pre', 'process-output-body');
        output.textContent = logs
          .slice(-200)
          .map((entry) => `${formatClock(entry.at)} ${entry.message}`)
          .join('\n');
        details.appendChild(output);
      }
      body.appendChild(details);
    });
  }

  function renderGlobalDiagnostics(kind, id, executions) {
    const ids = new Set(executions.map((execution) => execution.id));
    const entries = state.diagnostics.filter((entry) => {
      if (ids.has(entry.executionId)) return true;
      if (kind === 'phase') return entry.phase === id;
      return typeof entry.story === 'string' && entry.story.split(',').includes(id);
    });
    if (entries.length === 0) return;
    drawerSection('Diagnóstico global persistente', (body) => {
      const details = el('details', 'process-output');
      details.appendChild(
        el('summary', null, `${entries.length} registro(s) em ~/.issue-flow/logs`),
      );
      const output = el('pre', 'process-output-body');
      output.textContent = entries
        .slice(0, 200)
        .map((entry) => `${formatClock(entry.timestamp)} ${entry.level} ${entry.message}`)
        .join('\n');
      details.appendChild(output);
      body.appendChild(details);
    });
  }

  // Reidrata a partir de kind/id a cada render: o drawer sobrevive ao poll.
  function renderDrawer(snapshot) {
    if (state.selectedDetail === null) return;
    const kind = state.selectedDetail.kind;
    const id = state.selectedDetail.id;
    const story = kind === 'story' ? getStoryById(snapshot, id) : null;
    const phase =
      kind === 'phase' ? list(snapshot.phases).find((entry) => entry.name === id) : null;
    if ((kind === 'story' && story === null) || (kind === 'phase' && !phase)) {
      closeDrawer();
      return;
    }

    clear(els.drawerBody);
    if (kind === 'phase') {
      els.drawerTitle.textContent = `Fase · ${phase.name}`;
      els.drawerBody.appendChild(el('span', `badge status-${phase.status}`, phase.status));
      const grid = el('dl', 'now-grid drawer-summary-grid');
      nowRow(grid, 'Início', phase.startedAt ? formatClock(phase.startedAt) : '—');
      nowRow(grid, 'Fim', phase.endedAt ? formatClock(phase.endedAt) : '—');
      nowRow(
        grid,
        'Duração',
        metric(phase.durationSeconds) !== null ? formatDuration(phase.durationSeconds) : '—',
      );
      nowRow(grid, 'Uso total', formatUsage(phase) || '—');
      const configured = list(snapshot.configuration?.phases).find(
        (entry) => entry.phase === phase.name,
      );
      if (configured) {
        nowRow(grid, 'Harness efetivo', configured.provider.value || '—');
        nowRow(grid, 'Origem', configSourceLabel(configured.provider.source));
        nowRow(grid, 'Modelo efetivo', configured.model.value || 'default do provider');
      }
      els.drawerBody.appendChild(grid);
      if (phase.error) els.drawerBody.appendChild(el('p', 'item-error', phase.error));
      const executions = executionsFor(snapshot, kind, id);
      renderExecutionHistory(snapshot, executions);
      renderProcessLogs(snapshot, executions, phase.name);
      renderGlobalDiagnostics(kind, id, executions);
      return;
    }

    els.drawerTitle.textContent = `${story.id} · ${story.title}`;
    els.drawerBody.appendChild(
      el('span', `badge story-status-${story.status}`, STORY_STATUS_LABELS[story.status]),
    );

    const timing = itemSideText([
      story.completedAt ? `concluída ${formatClock(story.completedAt)}` : '',
      metric(story.durationSeconds) !== null ? formatDuration(story.durationSeconds) : '',
    ]);
    if (timing) els.drawerBody.appendChild(el('p', 'muted drawer-timing', timing));

    drawerSection('Descrição', (body) => {
      body.appendChild(
        story.description
          ? el('p', 'drawer-text', story.description)
          : el('p', 'empty', 'Sem descrição.'),
      );
    });

    drawerSection('Critérios de aceite', (body) => {
      if (story.acceptanceCriteria.length === 0) {
        body.appendChild(el('p', 'empty', 'Nenhum critério declarado.'));
        return;
      }
      const items = el('ul', 'drawer-list');
      for (const criterion of story.acceptanceCriteria)
        items.appendChild(el('li', null, criterion));
      body.appendChild(items);
    });

    drawerSection('Dependências', (body) => {
      if (story.dependencies.length === 0) {
        body.appendChild(el('p', 'empty', 'Nenhuma dependência.'));
        return;
      }
      const row = el('div', 'badge-row');
      for (const dependency of story.dependencies) {
        row.appendChild(el('span', 'badge label-badge', dependency));
      }
      body.appendChild(row);
    });

    // Nenhum campo de histórico existe no snapshot hoje; a seção só aparece se
    // uma versão futura publicar um.
    const history = list(story.history);
    if (history.length > 0) {
      drawerSection('Histórico', (body) => {
        const entries = el('ol', 'drawer-list');
        for (const entry of history) {
          const item = el('li');
          if (entry.at) item.appendChild(el('span', 'log-time', formatClock(entry.at)));
          item.appendChild(
            document.createTextNode(
              (STORY_STAGE_LABELS[entry.stage] || entry.stage || '') +
                (entry.detail ? ` · ${entry.detail}` : ''),
            ),
          );
          entries.appendChild(item);
        }
        body.appendChild(entries);
      });
    }
    const executions = executionsFor(snapshot, kind, id);
    renderExecutionHistory(snapshot, executions);
    renderProcessLogs(snapshot, executions, 'execute');
    renderGlobalDiagnostics(kind, id, executions);
  }

  function drawerSection(title, fill) {
    const section = el('section', 'drawer-section');
    section.appendChild(el('h3', 'drawer-section-title', title));
    fill(section);
    els.drawerBody.appendChild(section);
  }

  function openDrawer(kind, id) {
    state.selectedDetail = { kind, id };
    els.drawer.hidden = false;
    els.drawerOverlay.hidden = false;
    document.addEventListener('keydown', onDrawerKeydown);
    renderDrawer(state.snapshot);
    els.drawer.focus();
  }

  function closeDrawer() {
    const selected = state.selectedDetail;
    state.selectedDetail = null;
    els.drawer.hidden = true;
    els.drawerOverlay.hidden = true;
    document.removeEventListener('keydown', onDrawerKeydown);
    clear(els.drawerBody);
    // O card é recriado a cada render, então o foco volta pelo id, não por uma
    // referência guardada na abertura.
    const card =
      selected && selected.kind === 'story'
        ? els.kanban.querySelector(`[data-story-id="${selected.id}"]`)
        : null;
    if (card) card.focus();
  }

  function renderGit(snapshot) {
    const repo = repoUrl(snapshot);

    clear(els.commits);
    if (snapshot.git.commits.length === 0) {
      els.commits.appendChild(el('p', 'empty', 'Nenhum commit ainda.'));
    } else {
      for (const commit of snapshot.git.commits) {
        const item = el('li');
        const hash = repo
          ? link(`${repo}/commit/${commit.hash}`, commit.hash, 'mono commit-hash')
          : el('span', 'mono commit-hash', commit.hash);
        item.appendChild(hash);
        const subject = el('div', 'item-main item-title', commit.subject);
        const meta = itemSideText([
          commit.storyId || '',
          commit.committedAt ? formatClock(commit.committedAt) : '',
        ]);
        if (meta) subject.appendChild(el('span', 'muted commit-meta', meta));
        item.appendChild(subject);
        els.commits.appendChild(item);
      }
    }

    clear(els.pullRequests);
    if (snapshot.pullRequests.length === 0) {
      els.pullRequests.appendChild(el('p', 'empty', 'Nenhum pull request ainda.'));
    } else {
      for (const pr of snapshot.pullRequests) {
        const item = el('li');
        item.appendChild(link(pr.url, `#${pr.number}`));
        item.appendChild(el('div', 'item-main item-title', pr.title));
        els.pullRequests.appendChild(item);
      }
    }
  }

  function renderLogs(snapshot) {
    clear(els.logs);
    const filter = state.logFilter;
    const entries = snapshot.logs.filter((entry) => filter === 'all' || entry.level === filter);
    if (entries.length === 0) {
      els.logs.appendChild(el('p', 'empty', 'Nenhum log para exibir.'));
      return;
    }
    // Mais recentes primeiro: monitoramento lê o topo, sem gerenciar scroll.
    for (const entry of entries.slice().reverse()) {
      const item = el('li', `level-${entry.level}`);
      item.appendChild(el('span', 'log-time', formatClock(entry.at)));
      item.appendChild(el('span', 'log-level', entry.level));
      item.appendChild(el('span', 'log-message', entry.message));
      els.logs.appendChild(item);
    }
  }

  const RESILIENCE_EVENTS = new Set([
    'retry',
    'agent:attempt',
    'agent:activity',
    'agent:result',
    'failover',
  ]);

  function historyMessage(event) {
    switch (event.type) {
      case 'session:start':
        return 'Sessão iniciada';
      case 'session:end':
        return `Sessão encerrada: ${event.status}`;
      case 'phase:start':
        return `Fase iniciada: ${event.phase}`;
      case 'phase:end':
        return `Fase encerrada: ${event.phase}${event.success ? ' (ok)' : ' (falhou)'}`;
      case 'iteration:start':
        return `Iteração ${event.iteration} iniciada`;
      case 'iteration:end':
        return `Iteração ${event.iteration} encerrada`;
      case 'retry':
        return `Retry ${event.attempt}${event.kind ? `: ${event.kind}` : ''}`;
      case 'agent:attempt':
        return `Tentativa ${event.attempt} com ${event.provider}`;
      case 'agent:activity':
        return `Atividade recebida de ${event.provider}`;
      case 'agent:result':
        return (
          event.provider +
          (event.success
            ? ' concluiu a tentativa'
            : ` falhou: ${event.failureKind || 'desconhecida'}`)
        );
      case 'failover':
        return (
          'Failover de ' +
          event.from +
          ' para ' +
          event.to +
          (event.reason ? `: ${event.reason}` : '')
        );
      case 'correction:cycle':
        return `Ciclo de correção ${event.cycle}/${event.maxCycles}`;
      case 'log':
        return event.message;
      default:
        return event.type;
    }
  }

  function renderHistory() {
    clear(els.history);
    const entries = state.events.filter((entry) => {
      const type = entry?.event?.type;
      if (!type) return false;
      if (state.historyFilter === 'resilience') return RESILIENCE_EVENTS.has(type);
      if (state.historyFilter === 'pipeline') return !RESILIENCE_EVENTS.has(type);
      return true;
    });
    if (entries.length === 0) {
      els.history.appendChild(el('p', 'empty', 'Nenhum evento para exibir.'));
      return;
    }
    for (const entry of entries.slice().reverse()) {
      const event = entry.event;
      const item = el('li', 'history-entry');
      item.appendChild(el('span', 'log-time', formatClock(event.at)));
      item.appendChild(el('span', 'history-type mono', event.type));
      item.appendChild(el('span', 'history-message', historyMessage(event)));
      els.history.appendChild(item);
    }
  }

  function renderMeta(snapshot) {
    const parts = [];
    if (snapshot.sessionId) parts.push(`execução ${snapshot.sessionId}`);
    if (snapshot.updatedAt) parts.push(`atualizado ${formatClock(snapshot.updatedAt)}`);
    parts.push('somente leitura');
    els.sessionMeta.textContent = parts.join(' · ');
  }

  // Relógios em tempo real (1s): tempo decorrido, estimativa e "há quanto
  // tempo" da atividade — sem esperar o próximo poll.
  function renderTimers() {
    const snapshot = state.snapshot;
    if (!snapshot) return;

    const startMs = parseIso(snapshot.startedAt);
    if (startMs === null) {
      els.elapsed.textContent = '—';
    } else {
      const endMs = parseIso(snapshot.endedAt);
      const end = snapshot.status === 'running' || endMs === null ? Date.now() : endMs;
      els.elapsed.textContent = formatDuration((end - startMs) / 1000);
    }

    const estimate = snapshot.estimatedRemainingSeconds;
    if (snapshot.status === 'running' && estimate !== null) {
      els.estimate.hidden = false;
      els.estimate.textContent = `~${formatDuration(estimate)} restantes (estimativa)`;
    } else {
      els.estimate.hidden = true;
    }

    const since = els.now.querySelector('[data-since]');
    if (since) since.textContent = formatAgo(since.dataset.since);
  }

  // ---- Inicialização --------------------------------------------------------

  function onThemeChange(select) {
    setTheme(select.value);
    storeTheme(state.theme);
  }

  function onRefreshChange(select) {
    state.refreshSeconds = Number(select.value);
    storeRefresh(state.refreshSeconds);
    buildRefreshSelect();
    clearTimer();
    // "pausar" precisa pausar de verdade: com o stream aberto o servidor
    // continuaria empurrando, e o seletor viraria enfeite.
    if (state.refreshSeconds === PAUSED) {
      disconnectStream();
      return;
    }
    connectStream();
    poll();
  }

  async function init() {
    const tablist = document.querySelector('[role="tablist"]');
    if (tablist) tablist.addEventListener('keydown', onTabListKeydown);
    for (const tab of els.tabs) {
      tab.addEventListener('click', () => setActiveTab(tab.id));
    }
    setActiveTab(state.activeTab);

    els.drawerClose.addEventListener('click', closeDrawer);
    els.drawerOverlay.addEventListener('click', closeDrawer);
    els.backToDashboard.addEventListener('click', clearSessionSelection);

    els.refreshSelect.addEventListener('change', () => onRefreshChange(els.refreshSelect));
    if (els.refreshSelectDashboard) {
      els.refreshSelectDashboard.addEventListener('change', () =>
        onRefreshChange(els.refreshSelectDashboard),
      );
    }

    els.themeSelect.addEventListener('change', () => onThemeChange(els.themeSelect));
    if (els.themeSelectDashboard) {
      els.themeSelectDashboard.addEventListener('change', () =>
        onThemeChange(els.themeSelectDashboard),
      );
    }
    initTheme();

    els.logFilter.addEventListener('change', () => {
      state.logFilter = els.logFilter.value;
      if (state.snapshot) renderLogs(state.snapshot);
    });
    els.historyFilter.addEventListener('change', () => {
      state.historyFilter = els.historyFilter.value;
      renderHistory();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimer();
      else poll();
    });
    // O navegador pode ter congelado a conexão em background; voltar online é
    // o momento certo de garantir que ela existe.
    window.addEventListener('online', () => {
      if (stream.connected) return;
      connectStream();
      poll();
    });

    // Default do seletor vem da configuração do servidor (/api/health);
    // a escolha do usuário em localStorage tem precedência.
    const stored = readStoredRefresh();
    try {
      const healthRes = await fetch('api/health', { cache: 'no-store' });
      serverInstanceChanged(healthRes);
      const health = await healthRes.json();
      renderMonitorVersion(health.version);
      const capabilities = list(health.capabilities);
      state.configWritable =
        capabilities.includes('config:agent:write') &&
        capabilities.includes('config:routing:write');
      const suggested = Number(health.refreshSeconds);
      if (stored === null && Number.isFinite(suggested) && suggested > 0) {
        state.refreshSeconds = suggested;
      }
    } catch (_err) {
      // Sem /api/health segue o default local (5s).
    }
    if (stored !== null) state.refreshSeconds = stored;
    buildRefreshSelect();

    window.setInterval(renderTimers, 1000);
    connectStream();
    poll();
  }

  init();
})();
