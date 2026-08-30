// Interface do monitoramento web do issue-flow.
// JS puro, sem framework e sem recursos externos — funciona offline.
// Consome GET api/sessions, GET api/status (ETag/304), GET api/events e GET api/health;
// todo texto dinâmico entra via textContent (nunca innerHTML com dados
// do snapshot).
(() => {
  'use strict';

  const REFRESH_OPTIONS = [3, 5, 10, 30];
  const PAUSED = 0;
  const STORAGE_KEY = 'issue-flow:refresh-seconds';
  // A chave 'issue-flow:theme' também é lida pelo <script> inline do <head>
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
    // 'system' | 'light' | 'dark'. Valor inicial em initTheme(), a partir do
    // que o <script> inline do <head> já aplicou na raiz.
    theme: 'system',
    historyFilter: 'all',
    events: [],
    // Só o id: o card que abriu o drawer é destruído no próximo render, então
    // guardar o nó levaria a uma referência morta.
    selectedStoryId: null,
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

  // ---- Utilitários ----------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'min ' + String(seconds % 60).padStart(2, '0') + 's';
    const hours = Math.floor(minutes / 60);
    return hours + 'h ' + String(minutes % 60).padStart(2, '0') + 'min';
  }

  function formatAgo(iso) {
    const ms = parseIso(iso);
    if (ms === null) return '';
    return 'há ' + formatDuration((Date.now() - ms) / 1000);
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
    if (abs >= 1000000) return (value / 1000000).toFixed(1) + 'M';
    if (abs >= 1000) return (value / 1000).toFixed(1) + 'k';
    return String(Math.round(value));
  }

  // Custos abaixo de um centavo perderiam todo o significado com 2 casas.
  function formatCost(value) {
    return '~$' + (Math.abs(value) < 0.01 ? value.toFixed(4) : value.toFixed(2));
  }

  // Ex.: '12.4k in / 3.1k out · 88.0k cache · ~$0.42'. Segmentos sem dado são
  // omitidos; sem dado algum devolve '' — sinal para não renderizar nada.
  function formatUsage(usage) {
    if (!usage) return '';
    const segments = [];

    const input = metric(usage.inputTokens);
    const output = metric(usage.outputTokens);
    const io = [];
    if (input !== null) io.push(compactTokens(input) + ' in');
    if (output !== null) io.push(compactTokens(output) + ' out');
    if (io.length > 0) segments.push(io.join(' / '));

    const cacheRead = metric(usage.cacheReadTokens);
    const cacheCreation = metric(usage.cacheCreationTokens);
    if (cacheRead !== null || cacheCreation !== null) {
      segments.push(compactTokens((cacheRead || 0) + (cacheCreation || 0)) + ' cache');
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
    const url = snapshot.issue && snapshot.issue.url;
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
      stageSince: story.stageSince !== null && story.stageSince !== undefined ? story.stageSince : null,
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

  function setActiveTab(tabId) {
    state.activeTab = tabId;
    for (const tab of els.tabs) {
      const active = tab.id === tabId;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.classList.toggle('is-active', active);
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    }
  }

  // ---- Tema ------------------------------------------------------------------
  // Três estados: 'system' segue o SO (o @media decide), 'light'/'dark' forçam.
  // Quem pinta é o CSS; aqui só se define (ou remove) o data-theme da raiz.

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

  function setTheme(theme) {
    state.theme = theme === 'light' || theme === 'dark' ? theme : 'system';
    applyTheme(state.theme);
    syncThemeSelects();
  }

  function initTheme() {
    // O <script> inline do <head> já leu 'issue-flow:theme' e aplicou o tema
    // antes do primeiro paint; ler a raiz aqui reflete a preferência guardada
    // sem duplicar a leitura do localStorage uma terceira vez.
    setTheme(document.documentElement.getAttribute('data-theme') || 'system');
  }

  // ---- Polling: intervalo configurável, aba oculta e backoff ----------------

  function readStoredRefresh() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      // localStorage indisponível (ex.: bloqueado) — segue com o default.
    }
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function storeRefresh(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch (err) {
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
      const option = el('option', null, value + 's');
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
    if (mode === 'dashboard' && state.selectedStoryId !== null) {
      closeDrawer();
    }
  }

  function statusUrlFor(session) {
    if (!session || !session.statusUrl) return 'api/status';
    // statusUrl vem com barra inicial (/api/status?session=…); o fetch relativo
    // ao path do painel precisa da forma sem a barra absoluta do host.
    return session.statusUrl.replace(/^\//, '');
  }

  function eventsUrlFor(session) {
    if (!session || !session.eventsUrl) return null;
    return session.eventsUrl.replace(/^\//, '');
  }

  function clearDetailState() {
    state.etag = null;
    state.snapshot = null;
    state.detailSessionId = null;
    state.events = [];
    state.eventsUrl = null;
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
      if (!sessionsRes.ok) throw new Error('HTTP ' + sessionsRes.status);
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
        resolved.session && resolved.session.sessionId != null
          ? resolved.session.sessionId
          : null;
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
        if (!res.ok) throw new Error('HTTP ' + res.status);
        state.etag = res.headers.get('ETag');
        state.snapshot = await res.json();
        render();
      }
      if (state.eventsUrl) {
        const eventsRes = await fetch(state.eventsUrl, { cache: 'no-store' });
        if (!eventsRes.ok) throw new Error('HTTP ' + eventsRes.status);
        const entries = await eventsRes.json();
        state.events = Array.isArray(entries) ? entries : [];
        renderHistory();
      }
      setViewMode('detail');
      state.failures = 0;
      els.banner.hidden = true;
    } catch (err) {
      state.failures += 1;
      els.banner.hidden = false;
    } finally {
      state.polling = false;
      if (state.pollAgain) {
        state.pollAgain = false;
        poll();
      } else {
        schedule();
      }
    }
  }

  function renderEmptyDetail() {
    if (state.snapshot) return;
    document.title = 'issue-flow';
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
    return normalized.slice(0, max - 1).trimEnd() + '…';
  }

  function renderDashboard(sessions) {
    const active = document.activeElement;
    const focusedId =
      active &&
      active.dataset &&
      els.dashboard.contains(active) &&
      active.dataset.sessionId
        ? active.dataset.sessionId
        : null;

    clear(els.dashboard);

    if (sessions.length === 0) {
      els.dashboard.appendChild(el('p', 'empty', 'Nenhuma execução ativa.'));
      els.dashboardMeta.textContent = '0 execuções';
      document.title = 'issue-flow';
      return;
    }

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
      const badge = el('span', 'badge status-' + (session.status || 'idle'));
      badge.textContent = STATUS_LABELS[session.status] || session.status || '—';
      head.appendChild(project);
      head.appendChild(badge);
      card.appendChild(head);

      const titleRow = el('span', 'dashboard-title-row');
      if (session.issueNumber !== null && session.issueNumber !== undefined) {
        titleRow.appendChild(el('span', 'dashboard-issue', '#' + session.issueNumber));
      }
      titleRow.appendChild(
        el('span', 'dashboard-title', session.issueTitle || 'Sem título'),
      );
      card.appendChild(titleRow);

      const summary = truncateText(session.issueDescription, DESCRIPTION_PREVIEW);
      card.appendChild(el('span', 'dashboard-summary muted', summary || 'Sem descrição'));

      const meta = el('span', 'dashboard-meta-row');
      meta.appendChild(
        el('span', null, 'Fase: ' + (session.currentPhase || '—')),
      );
      const percent =
        typeof session.progressPercent === 'number' ? session.progressPercent : 0;
      meta.appendChild(el('span', null, percent + '%'));
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
        meta.appendChild(el('span', null, session.retries + ' retry(s)'));
      }
      if (typeof session.correctionCycle === 'number' && session.correctionCycle > 0) {
        meta.appendChild(el('span', null, 'correção ' + session.correctionCycle));
      }
      if (session.updatedAt) {
        meta.appendChild(
          el('span', null, 'atividade ' + formatAgo(session.lastActivityAt || session.updatedAt)),
        );
      }
      if (session.provider) meta.appendChild(el('span', null, 'provider ' + session.provider));
      if (typeof session.attempt === 'number' && session.attempt > 0) {
        meta.appendChild(el('span', null, 'tentativa ' + session.attempt));
      }
      card.appendChild(meta);

      const progress = el('span', 'dashboard-progress');
      const bar = el('span', 'dashboard-progress-bar');
      bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
      progress.appendChild(bar);
      card.appendChild(progress);

      if (session.status === 'running') {
        card.appendChild(el('span', 'dashboard-live-dot', 'ao vivo'));
      }

      card.addEventListener('click', () => {
        if (session.sessionId) selectSession(session.sessionId);
      });

      els.dashboard.appendChild(card);
    }

    els.dashboardMeta.textContent =
      sessions.length + (sessions.length === 1 ? ' execução' : ' execuções');
    document.title = sessions.length + ' execuções · issue-flow';

    if (focusedId) {
      const card = els.dashboard.querySelector(
        '[data-session-id="' + focusedId.replace(/"/g, '') + '"]',
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
    const issue = snapshot.issue.number !== null ? '#' + snapshot.issue.number : '';
    let prefix = '';
    if (snapshot.status === 'running') prefix = snapshot.progress.percent + '% · ';
    else if (snapshot.status === 'completed') prefix = '✓ ';
    else if (snapshot.status === 'failed') prefix = '✗ ';
    document.title = (prefix + issue + ' · issue-flow').replace(/^ · /, '');
  }

  function renderHeader(snapshot) {
    if (snapshot.issue.number !== null) {
      els.issueLink.hidden = false;
      els.issueLink.textContent = '#' + snapshot.issue.number;
      if (snapshot.issue.url) els.issueLink.href = snapshot.issue.url;
      else els.issueLink.removeAttribute('href');
    } else {
      els.issueLink.hidden = true;
    }

    const branch = snapshot.git.branch;
    const base = snapshot.git.baseBranch;
    els.branchLine.textContent = branch ? (base ? branch + ' ← ' + base : branch) : '';

    els.statusBadge.textContent = STATUS_LABELS[snapshot.status] || snapshot.status;
    els.statusBadge.className = 'badge status-' + snapshot.status;
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
    if (errors.length > 0) counts.push(errors.length + ' erro(s)');
    if (warnings.length > 0) counts.push(warnings.length + ' aviso(s)');
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
      entry.appendChild(el('span', 'mono', formatClock(log.at) + ' '));
      entry.appendChild(document.createTextNode(log.message));
      els.alertsBody.appendChild(entry);
    }
    for (const log of warnings.slice(-ALERT_PREVIEW)) {
      const entry = el('div', 'alert-entry level-warn');
      entry.appendChild(el('span', 'mono', formatClock(log.at) + ' '));
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

    const heading = el('p', 'issue-summary-title');
    heading.appendChild(
      el('span', 'mono', issue.number !== null && issue.number !== undefined ? '#' + issue.number : '—'),
    );
    heading.appendChild(document.createTextNode(' ' + (issue.title || 'Sem título')));
    els.issueSummary.appendChild(heading);

    const meta = el('div', 'issue-summary-meta');
    const state = issue.state || null;
    const stateClass = state === 'open' ? 'state-open' : state === 'closed' ? 'state-closed' : 'state-unknown';
    meta.appendChild(el('span', 'badge ' + stateClass, state || 'estado desconhecido'));
    meta.appendChild(el('span', 'muted', 'Prioridade: Não definida'));
    els.issueSummary.appendChild(meta);

    const labels = issue.labels || [];
    if (labels.length > 0) {
      const labelRow = el('div', 'badge-row');
      for (const label of labels) {
        labelRow.appendChild(el('span', 'badge label-badge', label));
      }
      els.issueSummary.appendChild(labelRow);
    }

    els.issueSummary.appendChild(el('p', 'issue-description', issue.description || 'Sem descrição.'));
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
    els.progressPercent.textContent = progress.percent + '%';
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
    els.progressCounters.textContent = totals ? counters + ' · ' + totals : counters;
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
        failed: 'Execução falhou — veja os erros acima.',
      };
      els.now.appendChild(el('p', 'empty', messages[snapshot.status] || '—'));
      return;
    }

    const grid = el('dl', 'now-grid');
    const phase = el('dd');
    if (snapshot.currentPhase) {
      phase.appendChild(el('span', 'pulse'));
      phase.appendChild(document.createTextNode(snapshot.currentPhase));
    } else {
      phase.textContent = '—';
    }
    grid.appendChild(el('dt', null, 'Fase'));
    grid.appendChild(phase);

    const activity = snapshot.currentActivity;
    if (activity) {
      if (activity.story) nowRow(grid, 'Story', activity.story);
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
      ? formatClock(resilience.lastActivityAt) + ' (' + formatAgo(resilience.lastActivityAt) + ')'
      : '—';
    nowRow(grid, 'Última atividade', activity);
    els.resilience.appendChild(grid);
  }

  function renderPhases(snapshot) {
    clear(els.phases);
    if (snapshot.phases.length === 0) {
      els.phases.appendChild(el('p', 'empty', 'Nenhuma fase registrada ainda.'));
      return;
    }
    for (const phase of snapshot.phases) {
      const item = el('li');
      item.appendChild(el('span', 'item-icon icon-' + phase.status, PHASE_ICONS[phase.status] || '○'));
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
      els.phases.appendChild(item);
    }
  }

  function renderNextSteps(snapshot) {
    clear(els.nextSteps);
    if (snapshot.nextSteps.length === 0) {
      const message =
        snapshot.status === 'completed' ? 'Pipeline concluído.' : 'Nenhum passo pendente.';
      els.nextSteps.appendChild(el('p', 'empty', message));
      return;
    }
    const list = el('ol');
    for (const step of snapshot.nextSteps) {
      list.appendChild(el('li', null, step));
    }
    els.nextSteps.appendChild(list);
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
      const storyStage = story.stage !== null && story.stage !== undefined ? story.stage : 'pending';
      const item = el('li', storyStage === 'executing' ? 'story-executing' : null);
      const status = story.passes ? 'completed' : 'pending';
      item.appendChild(el('span', 'item-icon icon-' + status, story.passes ? '✓' : '○'));
      const main = el('div', 'item-main');
      const title = el('div', 'item-title');
      title.appendChild(el('span', 'story-id', story.id));
      title.appendChild(document.createTextNode(story.title));
      main.appendChild(title);

      // status/dependencies vêm com default no schema (backlog/[]), mas
      // session.json gravado antes de #29 pode chegar sem eles.
      const storyStatus = story.status !== null && story.status !== undefined ? story.status : 'backlog';
      const meta = el('div', 'story-meta');
      meta.appendChild(
        el('span', 'badge story-status-' + storyStatus, STORY_STATUS_LABELS[storyStatus] || storyStatus),
      );
      const dependencies = story.dependencies || [];
      if (dependencies.length > 0) {
        meta.appendChild(el('span', 'muted story-deps', 'depende de: ' + dependencies.join(', ')));
      }
      main.appendChild(meta);

      item.appendChild(main);
      const duration = metric(story.durationSeconds);
      const stageLabel = STORY_STAGE_LABELS[storyStage] || storyStage;
      const stageText = story.stageSince
        ? stageLabel + ' ' + formatAgo(story.stageSince)
        : stageLabel;
      const side = itemSideText([
        stageText,
        story.completedAt ? 'concluída ' + formatClock(story.completedAt) : '',
        duration !== null ? formatDuration(duration) : '',
        formatUsage(story),
      ]);
      if (side) item.appendChild(el('span', 'item-side', side));
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
    head.appendChild(
      el('span', 'item-icon icon-' + (story.passes ? 'completed' : 'pending'), story.passes ? '✓' : '○'),
    );
    head.appendChild(el('span', 'story-id', story.id));
    card.appendChild(head);

    card.appendChild(el('span', 'kanban-card-title', story.title));
    if (story.description) card.appendChild(el('span', 'kanban-card-desc', story.description));
    card.appendChild(
      el('span', 'badge story-status-' + story.status, STORY_STATUS_LABELS[story.status]),
    );
    card.addEventListener('click', () => openDrawer(story.id));
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

  // Reidrata a partir do id a cada render: o drawer aberto sobrevive ao poll.
  function renderDrawer(snapshot) {
    if (state.selectedStoryId === null) return;
    const story = getStoryById(snapshot, state.selectedStoryId);
    // A story saiu do plano: manter o drawer aberto exibiria dados obsoletos.
    if (story === null) {
      closeDrawer();
      return;
    }
    els.drawerTitle.textContent = story.id + ' · ' + story.title;

    clear(els.drawerBody);
    els.drawerBody.appendChild(
      el('span', 'badge story-status-' + story.status, STORY_STATUS_LABELS[story.status]),
    );

    const timing = itemSideText([
      story.completedAt ? 'concluída ' + formatClock(story.completedAt) : '',
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
      for (const criterion of story.acceptanceCriteria) items.appendChild(el('li', null, criterion));
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
          item.appendChild(document.createTextNode(text(entry.message)));
          entries.appendChild(item);
        }
        body.appendChild(entries);
      });
    }
  }

  function drawerSection(title, fill) {
    const section = el('section', 'drawer-section');
    section.appendChild(el('h3', 'drawer-section-title', title));
    fill(section);
    els.drawerBody.appendChild(section);
  }

  function openDrawer(id) {
    state.selectedStoryId = id;
    els.drawer.hidden = false;
    els.drawerOverlay.hidden = false;
    document.addEventListener('keydown', onDrawerKeydown);
    renderDrawer(state.snapshot);
    els.drawer.focus();
  }

  function closeDrawer() {
    const id = state.selectedStoryId;
    state.selectedStoryId = null;
    els.drawer.hidden = true;
    els.drawerOverlay.hidden = true;
    document.removeEventListener('keydown', onDrawerKeydown);
    clear(els.drawerBody);
    // O card é recriado a cada render, então o foco volta pelo id, não por uma
    // referência guardada na abertura.
    const card = id ? els.kanban.querySelector('[data-story-id="' + id + '"]') : null;
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
          ? link(repo + '/commit/' + commit.hash, commit.hash, 'mono commit-hash')
          : el('span', 'mono commit-hash', commit.hash);
        item.appendChild(hash);
        const subject = el('div', 'item-main item-title', commit.subject);
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
        item.appendChild(link(pr.url, '#' + pr.number));
        item.appendChild(el('div', 'item-main item-title', pr.title));
        els.pullRequests.appendChild(item);
      }
    }
  }

  function renderLogs(snapshot) {
    clear(els.logs);
    const filter = state.logFilter;
    const entries = snapshot.logs.filter(
      (entry) => filter === 'all' || entry.level === filter,
    );
    if (entries.length === 0) {
      els.logs.appendChild(el('p', 'empty', 'Nenhum log para exibir.'));
      return;
    }
    // Mais recentes primeiro: monitoramento lê o topo, sem gerenciar scroll.
    for (const entry of entries.slice().reverse()) {
      const item = el('li', 'level-' + entry.level);
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
        return 'Sessão encerrada: ' + event.status;
      case 'phase:start':
        return 'Fase iniciada: ' + event.phase;
      case 'phase:end':
        return 'Fase encerrada: ' + event.phase + (event.success ? ' (ok)' : ' (falhou)');
      case 'iteration:start':
        return 'Iteração ' + event.iteration + ' iniciada';
      case 'iteration:end':
        return 'Iteração ' + event.iteration + ' encerrada';
      case 'retry':
        return 'Retry ' + event.attempt + (event.kind ? ': ' + event.kind : '');
      case 'agent:attempt':
        return 'Tentativa ' + event.attempt + ' com ' + event.provider;
      case 'agent:activity':
        return 'Atividade recebida de ' + event.provider;
      case 'agent:result':
        return event.provider + (event.success ? ' concluiu a tentativa' : ' falhou: ' + (event.failureKind || 'desconhecida'));
      case 'failover':
        return 'Failover de ' + event.from + ' para ' + event.to + (event.reason ? ': ' + event.reason : '');
      case 'correction:cycle':
        return 'Ciclo de correção ' + event.cycle + '/' + event.maxCycles;
      case 'log':
        return event.message;
      default:
        return event.type;
    }
  }

  function renderHistory() {
    clear(els.history);
    const entries = state.events.filter((entry) => {
      const type = entry && entry.event && entry.event.type;
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
    if (snapshot.sessionId) parts.push('sessão ' + snapshot.sessionId);
    if (snapshot.updatedAt) parts.push('atualizado ' + formatClock(snapshot.updatedAt));
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
      els.estimate.textContent = '~' + formatDuration(estimate) + ' restantes (estimativa)';
    } else {
      els.estimate.hidden = true;
    }

    const since = els.now.querySelector('[data-since]');
    if (since) since.textContent = formatAgo(since.dataset.since);
  }

  // ---- Inicialização --------------------------------------------------------

  function onThemeChange(select) {
    setTheme(select.value);
  }

  function onRefreshChange(select) {
    state.refreshSeconds = Number(select.value);
    storeRefresh(state.refreshSeconds);
    buildRefreshSelect();
    clearTimer();
    if (state.refreshSeconds !== PAUSED) poll();
  }

  async function init() {
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

    // Default do seletor vem da configuração do servidor (/api/health);
    // a escolha do usuário em localStorage tem precedência.
    const stored = readStoredRefresh();
    if (stored !== null) {
      state.refreshSeconds = stored;
    } else {
      try {
        const health = await fetch('api/health', { cache: 'no-store' }).then((r) => r.json());
        const suggested = Number(health.refreshSeconds);
        if (Number.isFinite(suggested) && suggested > 0) state.refreshSeconds = suggested;
      } catch (err) {
        // Sem /api/health segue o default local (5s).
      }
    }
    buildRefreshSelect();

    window.setInterval(renderTimers, 1000);
    poll();
  }

  init();
})();
