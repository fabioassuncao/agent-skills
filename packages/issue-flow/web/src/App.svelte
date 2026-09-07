<script lang="ts">
  import { type Component, onMount } from 'svelte';
  import CiDetailsDialog from './lib/CiDetailsDialog.svelte';
  import CommentReviewDialog from './lib/CommentReviewDialog.svelte';
  import ConfirmDialog from './lib/ConfirmDialog.svelte';
  import CreateWorktreeDialog from './lib/CreateWorktreeDialog.svelte';
  import ExecutionPanel from './lib/ExecutionPanel.svelte';
  import ExecutionSidebarList from './lib/ExecutionSidebarList.svelte';
  import ExecutionsDashboard from './lib/ExecutionsDashboard.svelte';
  import LinearDetailDialog from './lib/LinearDetailDialog.svelte';
  import LinearPanel from './lib/LinearPanel.svelte';
  import LinearPostDialog from './lib/LinearPostDialog.svelte';
  import MobileChatSurface from './lib/MobileChatSurface.svelte';
  import PaneBar from './lib/PaneBar.svelte';
  import ProjectSwitcher from './lib/ProjectSwitcher.svelte';
  import SettingsDialog from './lib/SettingsDialog.svelte';
  import SidebarRepoRow from './lib/SidebarRepoRow.svelte';
  import TabBar from './lib/TabBar.svelte';
  import Terminal from './lib/Terminal.svelte';
  import ToastStack from './lib/ToastStack.svelte';
  import Toggle from './lib/Toggle.svelte';
  import TopBar from './lib/TopBar.svelte';
  import WorktreeLabelDialog from './lib/WorktreeLabelDialog.svelte';
  import WorktreeList from './lib/WorktreeList.svelte';
  import WorktreeProfileDialog from './lib/WorktreeProfileDialog.svelte';
  import {
    CAPABILITY,
    api,
    canCall,
    canOpenSessions,
    createWorktreeTab,
    fetchAgentSessions,
    deleteWorktreeTab,
    fetchEffectiveConfig,
    fetchExecutionDiagnostics,
    fetchExecutionEvents,
    fetchExecutionStatus,
    fetchLinearIssues,
    fetchProjects,
    fetchSessions,
    fetchWorktrees,
    hasCapability,
    knownHealth,
    openSession,
    postWorktreeToLinear,
    refreshWorktreeAgentTerminal,
    selectWorktreeTab,
    setWorktreeLabel,
    setWorktreeProfile,
    subscribeSessions,
    watchInstanceIdentity,
    activePrefix,
  } from './lib/api';
  import type { DrawerSelection } from './lib/ExecutionDrawer.svelte';
  import {
    ALL_PROJECTS,
    PROJECT_STORAGE_KEY,
    REFRESH_PAUSED,
    REFRESH_STORAGE_KEY,
    resolveExecutionView,
    visibleSessions,
    type HistoryFilter,
    type JournalEntryView,
    type LogFilter,
  } from './lib/executions';
  import { readSnapshot, type ExecutionSnapshot } from './lib/snapshot';
  import { terminalThemeFromTokens, type ThemeKey } from './lib/themes';
  import { setToastController } from './lib/toast-context';
  import type {
    AgentSessionRow,
    AppConfig,
    AvailableBranch,
    CreateWorktreeRequest,
    DiffDialogProps,
    EffectiveConfigResponse,
    LinearIssue,
    LinearIssueAvailability,
    PostWorktreeToLinearRequest,
    PrEntry,
    ProjectSummary,
    SessionSummary,
    ToastInput,
    ToastItem,
    UiToastItem,
    WorktreeInfo,
  } from './lib/types';
  import {
    SSH_STORAGE_KEY,
    applyTheme,
    errorMessage,
    loadSavedSelectedWorktree,
    loadSavedSidebarWidth,
    loadSavedTheme,
    loadUseWebChatUi,
    makeCursorUrl,
    readStored,
    writeStored,
    resolveSelectedBranch,
    saveSelectedWorktree,
    saveSidebarWidth,
    saveUseWebChatUi,
    worktreeCreationPhaseLabel,
  } from './lib/utils';
  import {
    buildWorktreeListRows,
    countArchivedMatches,
    filterWorktrees,
    matchesWorktreeSearch,
  } from './lib/worktree-list';

  /**
   * The shell.
   *
   * ADAPT of `frontend/src/App.svelte` @ d8c9d5f (1.648 lines). Global state in
   * Svelte 5 runes, no state library and no router — the "route" is the first
   * path segment, which is the project prefix (§48.3), and that is preserved
   * exactly because it is what §47.2's prefix routing already does.
   *
   * What changed:
   *
   * - The migration sensor is gone (§48.1); the optional Linear panel is
   *   capability-gated and uses environment-only authentication server-side.
   * - **Polling is gone.** The upstream polls `/api/worktrees` every 5s (1s
   *   while creating). Here the monitor pushes on `/api/stream`, and §35 puts a
   *   hard 250 ms p95 ceiling on output→screen with no room to negotiate. The
   *   interval survives only as the safety net the push channel needs when it
   *   drops, and it is paused on a hidden tab exactly as upstream.
   * - **Everything worktree-shaped is capability-gated.** This monitor may be
   *   one a pipeline run bound inline, which serves executions and nothing
   *   else; the sidebar says so instead of showing an empty list that looks
   *   broken.
   * - **The terminal is keyed by session** and carries a token (ADR-10).
   * - **Theme is the panel's three options**, including the system listener
   *   that is attached only in `system` mode.
   */

  function createDefaultConfig(): AppConfig {
    return {
      name: '',
      services: [],
      profiles: [],
      agents: [],
      defaultProfileName: '',
      defaultAgentId: 'claude',
      autoName: false,
      startupEnvs: {},
      linkedRepos: [],
      autoRemoveOnMerge: false,
      linearAvailability: 'missing_api_key',
      linearAutoCreateWorktrees: false,
      projectDir: '',
      mainBranch: '',
    };
  }

  function supportsWorktreeChat(worktree: WorktreeInfo | undefined): boolean {
    if (!worktree?.agentName) return false;
    const agent = config.agents.find((candidate) => candidate.id === worktree.agentName);
    return (
      agent?.capabilities.inAppChat ??
      (worktree.agentName === 'codex' || worktree.agentName === 'claude')
    );
  }

  /**
   * Listing sessions and the worktrees they run in.
   *
   * Split from `worktrees` in phase 8D. That name gates twenty mutation routes
   * the port brought ahead of their backends; this one is the listing, which
   * `src/web/worktrees-api.ts` now serves from the agent sessions of §49. One
   * promise must not smuggle in the other, and the sidebar's second group has
   * been empty for exactly that reason.
   */
  const sessionsAvailable = hasCapability(CAPABILITY.sessions);
  /** The ported mutation surface: create, merge, archive, re-profile. */
  const worktreeMutations = hasCapability(CAPABILITY.worktreeMutations);
  /** Whether this monitor can open a session — the one click of I3 (§49.3). */
  const canOpenSession = canOpenSessions();
  const worktreesAvailable = sessionsAvailable || worktreeMutations;
  const preferencesWritable =
    hasCapability(CAPABILITY.configAgentWrite) && hasCapability(CAPABILITY.configRoutingWrite);


  let config = $state<AppConfig>(createDefaultConfig());
  let worktrees = $state<WorktreeInfo[]>([]);
  let selectedBranch = $state<string | null>(loadSavedSelectedWorktree());
  let hasLoadedWorktrees = $state(false);
  let removeBranch = $state<string | null>(null);
  let mergeBranch = $state<string | null>(null);
  let labelBranch = $state<string | null>(null);
  let labelLoading = $state(false);
  let labelError = $state('');
  let profileBranch = $state<string | null>(null);
  let profileLoading = $state(false);
  let profileError = $state('');
  let removingBranches = $state<Set<string>>(new Set());
  let showCreateDialog = $state(false);
  let showSettingsDialog = $state(false);
  let linearIssues = $state<LinearIssue[]>([]);
  let linearAvailability = $state<LinearIssueAvailability>('disabled');
  let linearDetail = $state<LinearIssue | null>(null);
  let assigningLinearIssue = $state<LinearIssue | null>(null);
  let postLinearBranch = $state<string | null>(null);
  let postingLinearBranches = $state<Set<string>>(new Set());
  let ciDetailsPr = $state<PrEntry | null>(null);
  let commentReviewPr = $state<PrEntry | null>(null);
  let showDiffDialog = $state(false);
  let DiffDialogComponent = $state<Component<DiffDialogProps> | null>(null);
  let pullMainConfirm = $state(false);
  let pullMainLoading = $state(false);
  let pullMainError = $state('');
  let pullMainForce = $state(false);
  let pullLinkedRepoAlias = $state<string | null>(null);
  let pullLinkedRepoLoading = $state(false);
  let pullLinkedRepoError = $state('');
  let pullLinkedRepoForce = $state(false);
  let pendingCreateCount = $state(0);
  let latestAutoSelectCreateId = -1;
  let nextCreateRequestId = 0;
  let nextAvailableBranchFetchId = 0;
  let nextBaseBranchFetchId = 0;
  let sshHost = $state(readStored(SSH_STORAGE_KEY) ?? '');
  let currentTheme = $state<ThemeKey>(loadSavedTheme());
  let useWebChatUi = $state(loadUseWebChatUi());
  let terminalTheme = $state(terminalThemeFromTokens());
  let disconnected = $state(false);
  let applyPollInterval: ((intervalMs: number, paused: boolean) => void) | null = null;
  let pendingCreateBranchHint = $state<string | null>(null);
  let availableBranches = $state<AvailableBranch[]>([]);
  let availableBranchesLoading = $state(false);
  let availableBranchesError = $state<string | null>(null);
  let baseBranches = $state<AvailableBranch[]>([]);
  let baseBranchesLoading = $state(false);
  let baseBranchesError = $state<string | null>(null);
  let lockedBaseBranch = $state<string | null>(null);
  let includeRemoteBranches = $state(false);
  let searchQuery = $state('');
  let worktreeSearchInput = $state<HTMLInputElement | null>(null);
  let showArchivedWorktrees = $state(false);
  type BranchCacheKey = 'local' | 'remote';
  let availableBranchCache: Partial<Record<BranchCacheKey, AvailableBranch[]>> = {};
  let availableBranchRequests: Partial<Record<BranchCacheKey, Promise<AvailableBranch[]>>> = {};
  let baseBranchCache: AvailableBranch[] | null = null;
  let baseBranchRequest: Promise<AvailableBranch[]> | null = null;
  let diffDialogLoad: Promise<void> | null = null;

  // Only the system mode observes OS changes. Explicit modes — including the
  // five named palettes — are complete choices and must not retain a listener
  // that can repaint the terminal behind the user's back (U15).
  $effect(() => {
    if (currentTheme !== 'system' || typeof window === 'undefined') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const syncTerminalTheme = (): void => {
      terminalTheme = terminalThemeFromTokens();
    };
    query.addEventListener('change', syncTerminalTheme);
    return () => query.removeEventListener('change', syncTerminalTheme);
  });

  /**
   * The user's refresh interval (U16). Declared here because the safety net's
   * period derives from it, and both headers bind to this one value — which is
   * what makes "synchronised between the headers" true by construction rather
   * than by a synchronisation step somebody has to remember.
   */
  let refreshSeconds = $state<number>(readStoredRefresh() ?? 5);

  const DEFAULT_POLL_INTERVAL_MS = 15000;
  const ACTIVE_CREATE_POLL_INTERVAL_MS = 1000;

  let uiToasts = $state<UiToastItem[]>([]);
  const AUTO_DISMISS_MS = 4000;
  let nextToastId = 0;

  let notifiedBranches = $state<Set<string>>(new Set());
  let toasts = $derived<ToastItem[]>([...uiToasts]);

  function getAvailableBranchCacheKey(includeRemote: boolean): BranchCacheKey {
    return includeRemote ? 'remote' : 'local';
  }

  function fetchAvailableBranchesCached(includeRemote: boolean): Promise<AvailableBranch[]> {
    const key = getAvailableBranchCacheKey(includeRemote);
    const cached = availableBranchCache[key];
    if (cached) return Promise.resolve(cached);

    const inFlight = availableBranchRequests[key];
    if (inFlight) return inFlight;

    const request = api
      .fetchAvailableBranches({ query: { includeRemote } })
      .then((data) => {
        availableBranchCache[key] = data.branches;
        return data.branches;
      })
      .finally(() => {
        delete availableBranchRequests[key];
      });

    availableBranchRequests[key] = request;
    return request;
  }

  function fetchBaseBranchesCached(): Promise<AvailableBranch[]> {
    if (baseBranchCache) return Promise.resolve(baseBranchCache);
    if (baseBranchRequest) return baseBranchRequest;

    baseBranchRequest = api
      .fetchBaseBranches()
      .then((data) => {
        baseBranchCache = data.branches;
        return data.branches;
      })
      .finally(() => {
        baseBranchRequest = null;
      });

    return baseBranchRequest;
  }

  function invalidateBranchCaches(): void {
    availableBranchCache = {};
    availableBranchRequests = {};
    baseBranchCache = null;
    baseBranchRequest = null;
    availableBranches = [];
    availableBranchesError = null;
    availableBranchesLoading = false;
    baseBranches = [];
    baseBranchesError = null;
    baseBranchesLoading = false;
  }

  function showToast(toast: ToastInput): void {
    const id = `ui:${nextToastId++}`;
    uiToasts = [...uiToasts, { id, source: 'ui', ...toast }];
    setTimeout(() => {
      uiToasts = uiToasts.filter((item) => item.id !== id);
    }, AUTO_DISMISS_MS);
  }

  function ensureDiffDialogLoaded(): Promise<void> {
    if (DiffDialogComponent) return Promise.resolve();
    if (diffDialogLoad) return diffDialogLoad;

    diffDialogLoad = import('./lib/DiffDialog.svelte')
      .then(({ default: component }) => {
        DiffDialogComponent = component;
      })
      .finally(() => {
        diffDialogLoad = null;
      });

    return diffDialogLoad;
  }

  async function openDiffDialog(): Promise<void> {
    try {
      await ensureDiffDialogLoaded();
      showDiffDialog = true;
    } catch (err: unknown) {
      showToast({
        tone: 'error',
        message: 'Não foi possível carregar a visão de mudanças.',
        detail: errorMessage(err),
      });
    }
  }

  function handleDismissToast(id: string): void {
    uiToasts = uiToasts.filter((item) => item.id !== id);
  }

  setToastController({
    show: showToast,
    info: (message, detail) => showToast({ tone: 'info', message, ...(detail ? { detail } : {}) }),
    success: (message, detail) =>
      showToast({ tone: 'success', message, ...(detail ? { detail } : {}) }),
    error: (message, detail) =>
      showToast({ tone: 'error', message, ...(detail ? { detail } : {}) }),
  });

  // Sidebar resize
  const MIN_SIDEBAR_WIDTH = 140;
  const MAX_SIDEBAR_WIDTH = 500;
  const SIDEBAR_KEYBOARD_STEP = 10;
  let sidebarWidth = $state(
    Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, loadSavedSidebarWidth())),
  );
  let isResizingSidebar = $state(false);

  function clampSidebarWidth(w: number): number {
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w));
  }

  function handleResizeStart(e: PointerEvent) {
    e.preventDefault();
    isResizingSidebar = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    function onPointerMove(ev: PointerEvent) {
      sidebarWidth = clampSidebarWidth(startWidth + ev.clientX - startX);
    }

    function onPointerUp() {
      isResizingSidebar = false;
      saveSidebarWidth(sidebarWidth);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function handleResizeKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? SIDEBAR_KEYBOARD_STEP : -SIDEBAR_KEYBOARD_STEP;
      sidebarWidth = clampSidebarWidth(sidebarWidth + delta);
      saveSidebarWidth(sidebarWidth);
    }
  }

  // Mobile state
  let isMobile = $state(false);
  let sidebarOpen = $state(false);
  let activePane = $state(0);
  let tabBusy = $state(false);
  let deleteTabConfirm = $state<{ branch: string; tabId: string; label: string } | null>(null);
  let terminalRef:
    | {
        sendSelectPane: (pane: number) => void;
      }
    | undefined = $state();

  let openingBranches = $state<Set<string>>(new Set());
  let archivingBranches = $state<Set<string>>(new Set());
  let refreshingAgentTerminalBranches = $state<Set<string>>(new Set());
  let terminalSessionRevisions = $state<Record<string, number>>({});
  let trimmedWorktreeSearch = $derived(searchQuery.trim());
  let archivedWorktreeCount = $derived(worktrees.filter((w) => w.archived).length);
  let hiddenArchivedMatchCount = $derived(
    showArchivedWorktrees ? 0 : countArchivedMatches(worktrees, trimmedWorktreeSearch),
  );
  let visibleWorktrees = $derived(
    filterWorktrees(worktrees, {
      query: trimmedWorktreeSearch,
      showArchived: showArchivedWorktrees,
    }),
  );
  let visibleWorktreeRows = $derived(buildWorktreeListRows(visibleWorktrees));
  let creatingWorktrees = $derived(worktrees.filter((w) => w.creating));
  let backendCreatingCount = $derived(creatingWorktrees.length);
  let activeCreateCount = $derived(Math.max(pendingCreateCount, backendCreatingCount));
  let hasCreatingWorktrees = $derived(activeCreateCount > 0);
  let selectableWorktrees = $derived(
    visibleWorktrees.filter((w) => !removingBranches.has(w.branch)),
  );
  let createIndicatorLabel = $derived(
    activeCreateCount === 1 ? 'Criando…' : `Criando ${activeCreateCount}…`,
  );
  let selectedVisibleWorktree = $derived(
    selectedBranch && !removingBranches.has(selectedBranch)
      ? visibleWorktrees.find((w) => w.branch === selectedBranch)
      : undefined,
  );
  let selectedWorktree = $derived(
    selectedBranch && !removingBranches.has(selectedBranch)
      ? worktrees.find((w) => w.branch === selectedBranch)
      : undefined,
  );
  let labelWorktree = $derived(
    labelBranch ? worktrees.find((w) => w.branch === labelBranch) : undefined,
  );
  let profileWorktree = $derived(
    profileBranch ? worktrees.find((w) => w.branch === profileBranch) : undefined,
  );
  let isSelectedOpening = $derived(selectedBranch ? openingBranches.has(selectedBranch) : false);
  let isSelectedArchiving = $derived(
    selectedBranch ? archivingBranches.has(selectedBranch) : false,
  );
  let isSelectedAgentTerminalRefreshing = $derived(
    selectedBranch ? refreshingAgentTerminalBranches.has(selectedBranch) : false,
  );
  /**
   * The safety net's period.
   *
   * Three inputs, in this order: a worktree being created wants the tighter
   * beat the upstream used; otherwise the user's own choice from the refresh
   * control (U16); otherwise the 15 s default. `pausar` is handled separately —
   * it stops the timer rather than lengthening it.
   */
  let pollIntervalMs = $derived(
    hasCreatingWorktrees
      ? ACTIVE_CREATE_POLL_INTERVAL_MS
      : refreshSeconds === REFRESH_PAUSED
        ? DEFAULT_POLL_INTERVAL_MS
        : refreshSeconds * 1000,
  );
  let worktreeListEmptyMessage = $derived(
    !worktreesAvailable
      ? 'Este monitor está acompanhando execuções. Worktrees aparecem quando o servidor os anuncia.'
      : trimmedWorktreeSearch
        ? hiddenArchivedMatchCount > 0
          ? 'Há correspondências arquivadas ocultas.'
          : `Nenhuma correspondência para "${trimmedWorktreeSearch}".`
        : archivedWorktreeCount > 0 && !showArchivedWorktrees
          ? 'Nenhum worktree ativo.'
          : 'Nenhum worktree encontrado.',
  );

  /* ------------------------------------------------------------------ *
   * Executions (Fase 8C)
   *
   * The panel's half of the shell, in the same runes the rest of the state
   * lives in — there is no store and no router here, and that is a decision
   * (§48.3), not an omission.
   *
   * One selection drives the main panel: an execution, or a worktree, never
   * both. That is what keeps §50.3's "one experience where the two overlap"
   * true instead of two screens sharing a sidebar.
   * ------------------------------------------------------------------ */

  let sessions = $state<SessionSummary[]>([]);
  let projects = $state<ProjectSummary[]>([]);
  /** Free sessions across every served project — the other half of §49.4 (I5). */
  let agentSessions = $state<AgentSessionRow[]>([]);
  let selectedExecutionId = $state<string | null>(null);
  let selectedProjectId = $state<string>(readStored(PROJECT_STORAGE_KEY) ?? ALL_PROJECTS);
  let snapshot = $state<ExecutionSnapshot | null>(null);
  /** Which session the snapshot on screen belongs to; guards against a flash. */
  let snapshotSessionId = $state<string | null>(null);
  let snapshotEtag: string | null = null;
  let executionEvents = $state<JournalEntryView[]>([]);
  let executionDiagnostics = $state<Record<string, unknown>[]>([]);
  let effectiveConfig = $state<EffectiveConfigResponse | null>(null);
  let monitorVersion = $state<string | null>(null);
  let activeTab = $state('execution');
  let logFilter = $state<LogFilter>('all');
  let historyFilter = $state<HistoryFilter>('all');
  let drawer = $state<DrawerSelection | null>(null);
  /** Ticks once a second so elapsed, estimate and "há quanto tempo" stay live. */
  let now = $state(Date.now());
  let executionsBusy = false;
  let executionsAgain = false;

  function readStoredRefresh(): number | null {
    const raw = readStored(REFRESH_STORAGE_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  let filteredSessions = $derived(visibleSessions(sessions, selectedProjectId));

  let executionView = $derived(
    resolveExecutionView({
      sessions,
      selectedSessionId: selectedExecutionId,
      selectedProjectId,
      projectCount: projects.length,
    }),
  );

  /* ------------------------------------------------------------------ *
   * The unified selection (§50.5).
   *
   * There is **one** panel, not an "execution area" and a "worktree area".
   * `selectionKind` records only which of the two lists the person clicked
   * last, because that decides which one gets to pick the other:
   *
   * - clicking an execution selects the Task; its sessions and worktrees are
   *   the rows that carry its id, and the first of them is the workspace the
   *   terminal opens on (I1);
   * - clicking a session selects that workspace, and **whether the workflow
   *   tabs appear is decided by the row's own `executionId`** — which is what
   *   makes the promotion of §49.2 free: a free session linked to an issue
   *   starts carrying one and the workflow simply appears (I4).
   *
   * A monitor a pipeline run bound inline announces neither `sessions` nor
   * `worktrees`, so it only ever has the execution surface — which is what
   * keeps a plain `issue-flow run` unchanged (ADR-03), and it is also the
   * acceptance invariant of §48.6: Roteiro B must not get in Roteiro A's way.
   * ------------------------------------------------------------------ */
  let selectionKind = $state<'execution' | 'session'>(
    worktreesAvailable ? 'session' : 'execution',
  );

  /** The workspace the terminal, the chat and the services describe. */
  let activeWorktree = $derived.by(() => {
    if (selectionKind === 'session') return selectedWorktree;
    const id = selectedExecutionId;
    if (id === null) return undefined;
    const rows = worktrees.filter((worktree) => worktree.executionId === id);
    return rows.find((worktree) => worktree.branch === selectedBranch) ?? rows[0];
  });

  /** The execution behind whatever is selected, from either direction. */
  let activeExecutionId = $derived(
    selectionKind === 'execution'
      ? selectedExecutionId
      : (selectedWorktree?.executionId ?? null),
  );

  /** The rows the "Sessões e worktrees" tab lists (I1). */
  let taskWorktrees = $derived.by(() => {
    const id = activeExecutionId;
    if (id !== null) return worktrees.filter((worktree) => worktree.executionId === id);
    return activeWorktree === undefined ? [] : [activeWorktree];
  });

  /**
   * The dashboard, or the panel.
   *
   * The dashboard is the answer to "nothing in particular is selected" — never
   * a second area. A session selection always has something to show, so it goes
   * straight to the panel.
   */
  /**
   * A selection whose execution has not arrived yet.
   *
   * Without this the panel would render the session mode for a beat and then
   * the workflow, and the free-session tab set opens on the Terminal — so a
   * Task would connect a shell for one frame and drop it. Saying "loading" is
   * both honest and cheaper than a socket nobody asked for.
   */
  let awaitingSnapshot = $derived(activeExecutionId !== null && snapshot === null);

  let showDashboard = $derived(
    selectionKind === 'execution'
      ? executionView.mode === 'dashboard' || activeExecutionId === null
      : activeWorktree === undefined,
  );

  /**
   * Whether the terminal can attach.
   *
   * Reads the **active** workspace, not the sidebar selection: a Task picks its
   * own workspace out of its rows, and the terminal tab has to describe the one
   * on screen. That single substitution is most of what makes a Task contain
   * its terminal instead of pointing at one.
   */
  let canConnect = $derived(
    activeWorktree !== undefined && activeWorktree.mux === '✓' && !activeWorktree.creating,
  );
  let showWebChat = $derived(useWebChatUi && canConnect && supportsWorktreeChat(activeWorktree));
  // Tabs only mean something for the built-in terminal agents that have a
  // forkable session, and only where the server serves tabs at all.
  let showTabBar = $derived(
    !showWebChat &&
      (activeWorktree?.tabs.length ?? 0) > 0 &&
      activeWorktree?.supportsTabs === true &&
      canCall('createWorktreeTab') &&
      (activeWorktree?.agentName === 'claude' || activeWorktree?.agentName === 'codex'),
  );
  let selectedSessionId = $derived(
    activeWorktree?.tabs.find((tab) => tab.tabId === activeWorktree?.activeTabId)?.sessionId ??
      activeWorktree?.tabs[0]?.sessionId ??
      null,
  );
  let activeBranch = $derived(activeWorktree?.branch ?? null);
  /**
   * Whether the Terminal tab is offered at all.
   *
   * The transport is announced by the server (ADR-10) and there has to be a
   * workspace to attach to. A tab that opened onto a refused handshake would be
   * the dishonest surface the capability gate exists to prevent.
   */
  let terminalAvailable = $derived(
    hasCapability(CAPABILITY.terminalAttach) && activeWorktree !== undefined && !showWebChat,
  );
  let selectedTerminalKey = $derived(
    activeBranch
      ? `${activeBranch}:${selectedSessionId ?? ''}:${terminalSessionRevisions[activeBranch] ?? 0}`
      : '',
  );

  function clearExecutionDetail(): void {
    snapshot = null;
    snapshotSessionId = null;
    snapshotEtag = null;
    executionEvents = [];
    executionDiagnostics = [];
  }

  function selectExecution(sessionId: string | null): void {
    if (selectedExecutionId !== sessionId) clearExecutionDetail();
    selectedExecutionId = sessionId;
    selectionKind = 'execution';
    if (isMobile) sidebarOpen = false;
    void refreshExecutions();
  }

  /**
   * The drawer holds the story **id**, never the card.
   *
   * The board is rebuilt on every update, so a node captured when the drawer
   * opened would be outside the document by the time it closes — which is also
   * why focus goes back through `[data-story-id]`.
   */
  function closeDrawer(): void {
    const selection = drawer;
    drawer = null;
    if (selection?.kind !== 'story') return;
    queueMicrotask(() => {
      const card = document.querySelector<HTMLElement>(
        `[data-story-id="${selection.id.replace(/"/g, '')}"]`,
      );
      card?.focus();
    });
  }

  let openingSession = $state(false);

  /**
   * "Nova sessão" — I3, and S1 of §49.5.
   *
   * One click, and deliberately no dialog: agent, branch, profile and prompt
   * are all optional on `POST /api/sessions`, and asking for any of them would
   * be exactly the ceremony a free session exists to skip. The branch is
   * generated server-side, and the session lands with its terminal open.
   */
  async function handleNewSession(): Promise<void> {
    if (openingSession) return;
    openingSession = true;
    try {
      const opened = await openSession();
      await refresh();
      selectionKind = 'session';
      selectedBranch = opened.branch;
      activeTab = 'terminal';
      if (isMobile) sidebarOpen = false;
      showToast({ tone: 'success', message: `Sessão aberta em ${opened.branch}` });
    } catch (err) {
      showToast({ tone: 'error', message: `Falha ao abrir a sessão: ${errorMessage(err)}` });
    } finally {
      openingSession = false;
    }
  }

  /**
   * Clicking a session in the sidebar.
   *
   * Selecting it *and* landing on its terminal, because that is what opening a
   * session means in Roteiro A. Selecting a row from inside a Task's
   * "Sessões e worktrees" tab uses `handleSelectWorktree` alone — there the
   * person is reading the list, not asking for a shell.
   */
  /**
   * Picking a workspace from **inside** a Task.
   *
   * It does not leave the Task: a Task contains its sessions (§50.5), so the
   * only thing that changes is which of them the terminal, the chat and the
   * services describe. Only the sidebar's session group changes what is
   * selected — that is `selectSessionRow`.
   */
  function selectWorkspace(branch: string): void {
    revealWorktreeInFilters(branch);
    selectedBranch = branch;
    notifiedBranches = new Set([...notifiedBranches].filter((candidate) => candidate !== branch));
  }

  function selectSessionRow(branch: string): void {
    handleSelectWorktree(branch);
    if (hasCapability(CAPABILITY.terminalAttach)) activeTab = 'terminal';
  }

  function selectProject(projectId: string): void {
    selectedProjectId = projectId;
    writeStored(PROJECT_STORAGE_KEY, projectId === ALL_PROJECTS ? null : projectId);
    // A different project invalidates the open execution: it may not even
    // belong to the project now chosen.
    selectExecution(null);
  }

  function setRefreshSeconds(seconds: number): void {
    refreshSeconds = seconds;
    writeStored(REFRESH_STORAGE_KEY, String(seconds));
  }

  /**
   * One pass over the execution surface.
   *
   * Re-entrancy is handled the way the current panel handles it: a call that
   * arrives mid-flight is **remembered**, not dropped, so clicking a card while
   * a refresh is running still lands.
   */
  async function refreshExecutions(): Promise<void> {
    if (executionsBusy) {
      executionsAgain = true;
      return;
    }
    executionsBusy = true;
    executionsAgain = false;
    try {
      projects = await fetchProjects().catch((): ProjectSummary[] => []);
      agentSessions = await fetchAgentSessions();
      sessions = await fetchSessions();
      disconnected = false;

      const view = resolveExecutionView({
        sessions,
        selectedSessionId: selectedExecutionId,
        selectedProjectId,
        projectCount: projects.length,
      });
      // The resolver owns the execution selection only while an execution is
      // what is selected. With a session selected, the execution to show is the
      // one that session belongs to — letting the resolver auto-pick here would
      // put a different Task's snapshot beside somebody's terminal.
      if (selectionKind === 'execution' && view.selectedSessionId !== selectedExecutionId) {
        selectedExecutionId = view.selectedSessionId;
      }

      const sessionId =
        selectionKind === 'session'
          ? (selectedWorktree?.executionId ?? null)
          : view.mode === 'dashboard'
            ? null
            : (view.session?.sessionId ?? null);

      if (sessionId === null) {
        clearExecutionDetail();
        return;
      }

      if (snapshotSessionId !== sessionId) {
        clearExecutionDetail();
        snapshotSessionId = sessionId;
      }

      const status = await fetchExecutionStatus(sessionId, snapshotEtag);
      if (status.kind === 'snapshot') {
        snapshot = readSnapshot(status.snapshot);
        snapshotEtag = status.etag;
      }

      const [events, diagnostics, config] = await Promise.all([
        fetchExecutionEvents(sessionId).catch((): JournalEntryView[] => []),
        fetchExecutionDiagnostics(sessionId).catch((): Record<string, unknown>[] => []),
        fetchEffectiveConfig(sessionId).catch((): EffectiveConfigResponse | null => null),
      ]);
      executionEvents = events as JournalEntryView[];
      executionDiagnostics = diagnostics as Record<string, unknown>[];
      if (config !== null) effectiveConfig = config;
    } catch {
      disconnected = true;
    } finally {
      executionsBusy = false;
      if (executionsAgain) {
        executionsAgain = false;
        void refreshExecutions();
      }
    }
  }

  $effect(() => {
    // The document title carries the brand; the heading carries the execution.
    if (snapshot === null) {
      document.title = config.name ? `${config.name} · issue-flow` : 'issue-flow';
      return;
    }
    const issue = snapshot.issue.number === null ? '' : `#${snapshot.issue.number}`;
    const prefix =
      snapshot.status === 'running'
        ? `${snapshot.progress.percent}% · `
        : snapshot.status === 'completed'
          ? '✓ '
          : snapshot.status === 'failed'
            ? '✗ '
            : '';
    document.title = `${prefix}${issue} · issue-flow`.replace(/^ · /, '');
  });

  $effect(() => {
    const nextSelectedBranch = resolveSelectedBranch(
      selectedBranch,
      trimmedWorktreeSearch ? selectedWorktree : selectedVisibleWorktree,
      selectableWorktrees,
      hasLoadedWorktrees,
    );
    if (nextSelectedBranch !== selectedBranch) {
      selectedBranch = nextSelectedBranch;
    }
  });

  $effect(() => {
    const branches = new Set(worktrees.map((worktree) => worktree.branch));
    const nextEntries = Object.entries(terminalSessionRevisions).filter(([branch]) =>
      branches.has(branch),
    );
    if (nextEntries.length !== Object.keys(terminalSessionRevisions).length) {
      terminalSessionRevisions = Object.fromEntries(nextEntries);
    }
  });

  $effect(() => {
    if (pendingCreateCount === 0 || latestAutoSelectCreateId === -1) return;
    const target = pendingCreateBranchHint
      ? worktrees.find((w) => w.branch === pendingCreateBranchHint)
      : creatingWorktrees.length === 1
        ? creatingWorktrees[0]
        : undefined;
    if (!target) return;
    revealWorktreeInFilters(target.branch);
    selectedBranch = target.branch;
    if (isMobile) sidebarOpen = false;
  });

  $effect(() => {
    applyPollInterval?.(pollIntervalMs, refreshSeconds === REFRESH_PAUSED);
  });

  $effect(() => {
    if (!hasLoadedWorktrees) return;
    if (selectedWorktree) {
      saveSelectedWorktree(selectedWorktree.branch);
      return;
    }
    if (selectableWorktrees.length === 0) {
      saveSelectedWorktree(null);
    }
  });

  $effect(() => {
    if (!showCreateDialog || !canCall('fetchAvailableBranches')) return;

    const cached = availableBranchCache[getAvailableBranchCacheKey(includeRemoteBranches)];
    if (cached) {
      availableBranches = cached;
      availableBranchesLoading = false;
      availableBranchesError = null;
      return;
    }

    const fetchId = ++nextAvailableBranchFetchId;
    availableBranchesLoading = true;
    availableBranchesError = null;

    fetchAvailableBranchesCached(includeRemoteBranches)
      .then((branches) => {
        if (fetchId !== nextAvailableBranchFetchId) return;
        availableBranches = branches;
      })
      .catch((err: unknown) => {
        if (fetchId !== nextAvailableBranchFetchId) return;
        availableBranchesError = errorMessage(err);
      })
      .finally(() => {
        if (fetchId !== nextAvailableBranchFetchId) return;
        availableBranchesLoading = false;
      });
  });

  $effect(() => {
    if (!showCreateDialog || !canCall('fetchBaseBranches')) return;

    if (baseBranchCache) {
      baseBranches = baseBranchCache;
      baseBranchesLoading = false;
      baseBranchesError = null;
      return;
    }

    const fetchId = ++nextBaseBranchFetchId;
    baseBranches = [];
    baseBranchesLoading = true;
    baseBranchesError = null;

    fetchBaseBranchesCached()
      .then((branches) => {
        if (fetchId !== nextBaseBranchFetchId) return;
        baseBranches = branches;
      })
      .catch((err: unknown) => {
        if (fetchId !== nextBaseBranchFetchId) return;
        baseBranchesError = errorMessage(err);
      })
      .finally(() => {
        if (fetchId !== nextBaseBranchFetchId) return;
        baseBranchesLoading = false;
      });
  });

  let paneBarPanes = $derived.by(() => {
    const count = activeWorktree?.paneCount ?? 0;
    if (count < 2) return [];
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      label: String(i + 1),
    }));
  });
  let showPaneBar = $derived(
    isMobile && canConnect && !showWebChat && activeTab === 'terminal' && paneBarPanes.length > 0,
  );

  function branchSuffix(branch: string): string {
    return branch.includes('/') ? branch.slice(branch.lastIndexOf('/') + 1) : branch;
  }

  function linkedLinearIssue(branch: string): LinearIssue | null {
    return (
      linearIssues.find(
        (issue) =>
          branch === issue.branchName || branchSuffix(branch) === branchSuffix(issue.branchName),
      ) ?? null
    );
  }

  function linkLinearIssues(rows: WorktreeInfo[]): WorktreeInfo[] {
    return rows.map((worktree) => ({
      ...worktree,
      linearIssue: linkedLinearIssue(worktree.branch),
    }));
  }

  async function refreshLinear(): Promise<void> {
    if (!canCall('fetchLinearIssues')) return;
    try {
      const response = await fetchLinearIssues();
      linearAvailability = response.availability;
      linearIssues = response.issues;
      worktrees = linkLinearIssues(worktrees);
    } catch (err) {
      console.error('Falha ao atualizar o Linear:', err);
    }
  }

  async function refresh() {
    if (!canCall('fetchWorktrees')) {
      hasLoadedWorktrees = true;
      return;
    }
    try {
      worktrees = linkLinearIssues(await fetchWorktrees());
      hasLoadedWorktrees = true;
      disconnected = false;
    } catch (err) {
      disconnected = true;
      console.error('Falha ao atualizar:', err);
    }
  }

  function openCreateDialog(): void {
    assigningLinearIssue = null;
    includeRemoteBranches = false;
    lockedBaseBranch = null;
    showCreateDialog = true;
  }

  function openSubworktreeDialog(parentBranch: string): void {
    assigningLinearIssue = null;
    includeRemoteBranches = false;
    lockedBaseBranch = parentBranch;
    showCreateDialog = true;
  }

  function assignLinear(issue: LinearIssue): void {
    linearDetail = null;
    assigningLinearIssue = issue;
    includeRemoteBranches = false;
    lockedBaseBranch = null;
    showCreateDialog = true;
  }

  async function sendConversationToLinear(
    branch: string,
    target: PostWorktreeToLinearRequest['target'],
  ): Promise<void> {
    postingLinearBranches = new Set([...postingLinearBranches, branch]);
    try {
      const result = await postWorktreeToLinear(branch, { target });
      showToast({ tone: 'success', message: `Conversa enviada para ${result.issueId}` });
      postLinearBranch = null;
      await refreshLinear();
    } catch (error) {
      showToast({ tone: 'error', message: `Falha ao enviar ao Linear: ${errorMessage(error)}` });
      throw error;
    } finally {
      postingLinearBranches = new Set([...postingLinearBranches].filter((value) => value !== branch));
    }
  }

  function requestLinearPost(worktree: WorktreeInfo): void {
    if (worktree.linearIssue) {
      void sendConversationToLinear(worktree.branch, {
        kind: 'issue',
        issueId: worktree.linearIssue.id,
      }).catch(() => {
        // The helper already surfaced the failure in a toast. This fire-and-forget
        // menu action must not leak a rejected promise into the browser console.
      });
      return;
    }
    postLinearBranch = worktree.branch;
  }

  async function handleCreate(request: CreateWorktreeRequest) {
    const requestId = nextCreateRequestId++;
    const shouldAutoSelectCreatedWorktree = selectedWorktree == null;
    const requestedAgentIds =
      request.agents && request.agents.length > 0
        ? request.agents
        : request.agent
          ? [request.agent]
          : [config.defaultAgentId];
    const expectedCreatedCount = requestedAgentIds.length;
    if (shouldAutoSelectCreatedWorktree) {
      latestAutoSelectCreateId = requestId;
    }
    pendingCreateCount += expectedCreatedCount;
    if (shouldAutoSelectCreatedWorktree) {
      pendingCreateBranchHint = expectedCreatedCount > 1 ? null : (request.branch ?? null);
    }
    showCreateDialog = false;
    assigningLinearIssue = null;
    lockedBaseBranch = null;

    try {
      const createPromise = api.createWorktree({ body: request });
      void refresh();
      const result = await createPromise;
      if (shouldAutoSelectCreatedWorktree) {
        pendingCreateBranchHint = result.primaryBranch;
      }
      invalidateBranchCaches();
      await refresh();
      if (shouldAutoSelectCreatedWorktree && requestId === latestAutoSelectCreateId) {
        selectedBranch = result.primaryBranch;
        if (isMobile) sidebarOpen = false;
      }
    } catch (err) {
      showToast({ tone: 'error', message: `Falha ao criar: ${errorMessage(err)}` });
    } finally {
      pendingCreateCount = Math.max(0, pendingCreateCount - expectedCreatedCount);
      if (shouldAutoSelectCreatedWorktree && requestId === latestAutoSelectCreateId) {
        pendingCreateBranchHint = null;
        latestAutoSelectCreateId = -1;
      }
    }
  }

  function selectNeighborOf(branch: string) {
    if (selectedBranch !== branch) return;
    const orderedWorktrees = visibleWorktreeRows.map((row) => row.worktree);
    const idx = orderedWorktrees.findIndex((w) => w.branch === branch);
    const previous = orderedWorktrees[idx - 1];
    const next = orderedWorktrees[idx + 1];
    const neighbor = [previous, next].find(
      (candidate) => candidate && !removingBranches.has(candidate.branch),
    );
    selectedBranch = neighbor ? neighbor.branch : null;
  }

  function revealWorktreeInFilters(branch: string): void {
    const worktree = worktrees.find((candidate) => candidate.branch === branch);
    if (!worktree) return;
    if (worktree.archived) {
      showArchivedWorktrees = true;
    }
    if (trimmedWorktreeSearch && !matchesWorktreeSearch(worktree, trimmedWorktreeSearch)) {
      searchQuery = '';
    }
  }

  function handleSelectWorktree(branch: string): void {
    revealWorktreeInFilters(branch);
    selectedBranch = branch;
    selectionKind = 'session';
    notifiedBranches = new Set(
      [...notifiedBranches].filter((candidate) => candidate !== branch),
    );
    if (isMobile) sidebarOpen = false;
  }

  async function handleRemove() {
    const branch = removeBranch;
    if (!branch) return;
    removeBranch = null;
    selectNeighborOf(branch);

    removingBranches = new Set([...removingBranches, branch]);
    try {
      await api.removeWorktree({ params: { name: branch } });
      invalidateBranchCaches();
      await refresh();
    } catch (err) {
      showToast({ tone: 'error', message: `Falha ao remover: ${errorMessage(err)}` });
    } finally {
      removingBranches = new Set([...removingBranches].filter((b) => b !== branch));
    }
  }

  async function handleMerge() {
    const branch = mergeBranch;
    if (!branch) return;
    mergeBranch = null;
    selectNeighborOf(branch);

    removingBranches = new Set([...removingBranches, branch]);
    try {
      await api.mergeWorktree({ params: { name: branch } });
      invalidateBranchCaches();
      await refresh();
    } catch (err) {
      showToast({ tone: 'error', message: `Falha ao integrar: ${errorMessage(err)}` });
    } finally {
      removingBranches = new Set([...removingBranches].filter((b) => b !== branch));
    }
  }

  function openLabelDialog(): void {
    if (!selectedWorktree) return;
    labelBranch = selectedWorktree.branch;
    labelError = '';
  }

  function applyWorktreeLabel(branch: string, label: string | null): void {
    worktrees = worktrees.map((worktree) =>
      worktree.branch === branch ? { ...worktree, label } : worktree,
    );
  }

  async function handleLabelChange(label: string | null): Promise<void> {
    const branch = labelBranch;
    if (!branch) return;

    labelLoading = true;
    labelError = '';
    try {
      const nextLabel = await setWorktreeLabel(branch, label);
      applyWorktreeLabel(branch, nextLabel);
      labelBranch = null;
    } catch (err) {
      labelError = errorMessage(err);
    } finally {
      labelLoading = false;
    }
  }

  function openProfileDialog(branch: string): void {
    profileBranch = branch;
    profileError = '';
  }

  async function handleProfileChange(profile: string): Promise<void> {
    const branch = profileBranch;
    if (!branch) return;

    profileLoading = true;
    profileError = '';
    try {
      const result = await setWorktreeProfile(branch, profile);
      profileBranch = null;
      await refresh();
      if (result.restarted) {
        terminalSessionRevisions = {
          ...terminalSessionRevisions,
          [branch]: (terminalSessionRevisions[branch] ?? 0) + 1,
        };
      }
      showToast({
        tone: 'success',
        message: result.restarted
          ? `${branch} passou para o profile "${result.profile}"`
          : `${branch} passou para o profile "${result.profile}" — vale na próxima abertura`,
      });
    } catch (err) {
      profileError = errorMessage(err);
    } finally {
      profileLoading = false;
    }
  }

  async function handlePullMain(): Promise<void> {
    pullMainLoading = true;
    pullMainError = '';
    try {
      const result = await api.pullMain({
        body: { ...(pullMainForce ? { force: true } : {}) },
      });
      if (result.status === 'updated' || result.status === 'already_up_to_date') {
        pullMainConfirm = false;
        pullMainForce = false;
        showToast({
          tone: result.status === 'updated' ? 'success' : 'info',
          message:
            result.status === 'updated'
              ? `"${config.mainBranch || 'main'}" atualizada a partir do remoto`
              : `"${config.mainBranch || 'main'}" já está atualizada`,
        });
      } else if (result.status === 'merge_failed' && !pullMainForce) {
        pullMainForce = true;
        pullMainError = `O fast-forward falhou: ${
          result.error ?? 'erro desconhecido'
        }.\nA atualização forçada redefine a branch principal para o estado do remoto.`;
      } else {
        pullMainError = result.error ?? result.status;
      }
    } catch (err) {
      pullMainError = errorMessage(err);
    } finally {
      pullMainLoading = false;
    }
  }

  async function handlePullLinkedRepo(): Promise<void> {
    if (!pullLinkedRepoAlias) return;
    pullLinkedRepoLoading = true;
    pullLinkedRepoError = '';
    try {
      const result = await api.pullMain({
        body: {
          ...(pullLinkedRepoForce ? { force: true } : {}),
          ...(pullLinkedRepoAlias ? { repo: pullLinkedRepoAlias } : {}),
        },
      });
      if (result.status === 'updated' || result.status === 'already_up_to_date') {
        pullLinkedRepoAlias = null;
        pullLinkedRepoForce = false;
      } else if (result.status === 'merge_failed' && !pullLinkedRepoForce) {
        pullLinkedRepoForce = true;
        pullLinkedRepoError = `O fast-forward falhou: ${
          result.error ?? 'erro desconhecido'
        }.\nA atualização forçada redefine a branch para o estado do remoto.`;
      } else {
        pullLinkedRepoError = result.error ?? result.status;
      }
    } catch (err) {
      pullLinkedRepoError = errorMessage(err);
    } finally {
      pullLinkedRepoLoading = false;
    }
  }

  async function openSelectedWorktree(): Promise<void> {
    const branch = activeBranch;
    if (!branch) return;
    openingBranches = new Set([...openingBranches, branch]);
    try {
      await api.openWorktree({ params: { name: branch }, body: {} });
      await refresh();
    } catch (err) {
      showToast({ tone: 'error', message: `Falha ao abrir o worktree: ${errorMessage(err)}` });
    } finally {
      openingBranches = new Set([...openingBranches].filter((x) => x !== branch));
    }
  }

  async function toggleWorktreeArchived(branch: string): Promise<void> {
    const worktree = worktrees.find((candidate) => candidate.branch === branch);
    if (!worktree || worktree.creating) return;
    const nextArchived = !worktree.archived;
    const actionLabel = nextArchived ? 'arquivar' : 'restaurar';

    archivingBranches = new Set([...archivingBranches, branch]);
    try {
      await api.setWorktreeArchived({
        params: { name: branch },
        body: { archived: nextArchived },
      });
      await refresh();
    } catch (err) {
      showToast({
        tone: 'error',
        message: `Falha ao ${actionLabel} o worktree: ${errorMessage(err)}`,
      });
    } finally {
      archivingBranches = new Set(
        [...archivingBranches].filter((candidate) => candidate !== branch),
      );
    }
  }

  async function closeWorktree(branch: string): Promise<void> {
    selectNeighborOf(branch);
    try {
      await api.closeWorktree({ params: { name: branch } });
      await refresh();
    } catch (err) {
      showToast({ tone: 'error', message: `Falha ao fechar o worktree: ${errorMessage(err)}` });
    }
  }

  async function handleRefreshAgentTerminal(branch: string): Promise<void> {
    if (refreshingAgentTerminalBranches.has(branch)) return;
    refreshingAgentTerminalBranches = new Set([...refreshingAgentTerminalBranches, branch]);
    try {
      await refreshWorktreeAgentTerminal(branch);
      await refresh();
      terminalSessionRevisions = {
        ...terminalSessionRevisions,
        [branch]: (terminalSessionRevisions[branch] ?? 0) + 1,
      };
      showToast({ tone: 'success', message: 'Terminal do agente recarregado' });
    } catch (err) {
      showToast({
        tone: 'error',
        message: `Falha ao recarregar o terminal: ${errorMessage(err)}`,
      });
    } finally {
      refreshingAgentTerminalBranches = new Set(
        [...refreshingAgentTerminalBranches].filter((candidate) => candidate !== branch),
      );
    }
  }

  async function handleCreateTab(): Promise<void> {
    const branch = activeBranch;
    if (!branch || tabBusy) return;
    tabBusy = true;
    try {
      await createWorktreeTab(branch);
      await refresh();
    } catch (err) {
      showToast({ tone: 'error', message: `Falha ao criar a sessão: ${errorMessage(err)}` });
    } finally {
      tabBusy = false;
    }
  }

  async function handleSelectTab(tabId: string): Promise<void> {
    const branch = activeBranch;
    if (!branch || tabBusy) return;
    tabBusy = true;
    try {
      await selectWorktreeTab(branch, tabId);
      await refresh();
    } catch (err) {
      showToast({ tone: 'error', message: `Falha ao trocar de sessão: ${errorMessage(err)}` });
    } finally {
      tabBusy = false;
    }
  }

  async function handleDeleteTab(tabId: string): Promise<void> {
    const branch = activeBranch;
    if (!branch || tabBusy) return;
    const tab = activeWorktree?.tabs.find((candidate) => candidate.tabId === tabId);
    if (!tab || tab.kind === 'root') return;
    deleteTabConfirm = { branch, tabId, label: tab.label };
  }

  async function confirmDeleteTab(): Promise<void> {
    const target = deleteTabConfirm;
    if (!target || tabBusy) return;
    tabBusy = true;
    try {
      await deleteWorktreeTab(target.branch, target.tabId);
      await refresh();
      deleteTabConfirm = null;
    } catch (err) {
      showToast({ tone: 'error', message: `Falha ao encerrar a sessão: ${errorMessage(err)}` });
    } finally {
      tabBusy = false;
    }
  }

  async function handleArchiveToggle() {
    const branch = selectedBranch;
    if (!branch) return;
    await toggleWorktreeArchived(branch);
  }

  async function handleClose() {
    const branch = selectedBranch;
    if (!branch) return;
    await closeWorktree(branch);
  }

  function selectNeighborWorktree(direction: -1 | 1) {
    const selectable = visibleWorktrees.filter((w) => !removingBranches.has(w.branch));
    if (selectable.length === 0) return;
    if (!selectedBranch) {
      selectedBranch = selectable[direction === 1 ? 0 : selectable.length - 1].branch;
      return;
    }
    const idx = selectable.findIndex((w) => w.branch === selectedBranch);
    const next = idx + direction;
    if (next >= 0 && next < selectable.length) {
      selectedBranch = selectable[next].branch;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    // Ignore shortcuts while a dialog is open — it handles its own keys.
    if (
      showCreateDialog ||
      removeBranch ||
      mergeBranch ||
      pullMainConfirm ||
      pullLinkedRepoAlias
    ) {
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectNeighborWorktree(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectNeighborWorktree(1);
    } else if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      if (canOpenSession) void handleNewSession();
      else if (worktreeMutations) openCreateDialog();
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      if (selectedBranch) mergeBranch = selectedBranch;
    } else if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      if (selectedBranch) removeBranch = selectedBranch;
    } else if (e.key === 'Enter') {
      if (
        selectedWorktree &&
        selectedWorktree.mux !== '✓' &&
        !selectedWorktree.creating &&
        !isSelectedOpening
      ) {
        e.preventDefault();
        void openSelectedWorktree();
      }
    }
  }

  function handlePaneSelect(pane: number) {
    activePane = pane;
    terminalRef?.sendSelectPane(pane);
  }

  onMount(() => {
    applyTheme(currentTheme);
    terminalTheme = terminalThemeFromTokens();

    if (canCall('fetchConfig')) {
      api
        .fetchConfig()
        .then((c) => {
          config = c;
          linearAvailability = c.linearAvailability;
        })
        .catch(() => {});
    }
    void refresh();
    void refreshLinear();
    void refreshExecutions();

    // U17: the process that served these assets is identified on every
    // response; a different one means `--restart-web` put new code behind the
    // same origin, and the page has to reload to stop showing code the server
    // no longer agrees with. This is the asset handoff, not a session state.
    watchInstanceIdentity(() => window.location.reload());

    // The version chip is the **monitor's**, not the CLI's: these assets come
    // out of that process's memory, so it is the one that explains what is on
    // screen. The two appear side by side in "Contexto" when they differ.
    //
    // Read from the boot answer rather than asked again: `main.ts` already
    // fetched `/api/health` before anything mounted, and a second request on
    // every page load would change nothing.
    const health = knownHealth();
    if (health !== null) {
      monitorVersion = health.version;
      // The server's suggestion is the default; a stored choice outranks it.
      if (readStoredRefresh() === null && Number.isFinite(health.refreshSeconds)) {
        if (health.refreshSeconds > 0) refreshSeconds = health.refreshSeconds;
      }
    }

    // Elapsed, estimate and "há quanto tempo" are clocks, not poll results:
    // waiting for the next refresh to move them is what made the panel look
    // frozen during a long phase.
    const clock = setInterval(() => {
      now = Date.now();
    }, 1000);

    let intervalMs = pollIntervalMs;
    let interval: ReturnType<typeof setInterval> | undefined;
    window.addEventListener('keydown', handleKeydown);

    // The push channel. `/api/stream` is the delivery path; the interval below
    // is the safety net for when it drops, not the other way round.
    const unsubscribeStream = subscribeSessions({
      onSessions: () => {
        disconnected = false;
        void refresh();
        void refreshExecutions();
      },
      onStatus: () => {
        disconnected = false;
        void refreshExecutions();
      },
      onError: () => {
        disconnected = true;
      },
    });

    // Pause the safety net when the tab is hidden or the user has been idle for
    // a minute — the push channel keeps working either way.
    let idleTimer: ReturnType<typeof setTimeout>;
    let idle = false;

    function tick(): void {
      void refresh();
      void refreshExecutions();
    }

    function startPolling(): void {
      if (interval) clearInterval(interval);
      if (document.hidden || idle) return;
      // "pausar" pauses for real: the interval is the safety net, and a user who
      // turned it off must not keep being refreshed by it.
      if (refreshSeconds === REFRESH_PAUSED) return;
      interval = setInterval(tick, intervalMs);
    }

    let paused = refreshSeconds === REFRESH_PAUSED;
    applyPollInterval = (nextIntervalMs: number, nextPaused: boolean): void => {
      if (intervalMs === nextIntervalMs && paused === nextPaused) return;
      intervalMs = nextIntervalMs;
      paused = nextPaused;
      startPolling();
    };
    startPolling();

    function resetIdleTimer(): void {
      if (idle) {
        idle = false;
        void refresh();
        startPolling();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idle = true;
        if (interval) clearInterval(interval);
      }, 60_000);
    }

    document.addEventListener('click', resetIdleTimer);
    document.addEventListener('keydown', resetIdleTimer);
    resetIdleTimer();

    function onVisibilityChange(): void {
      if (document.hidden) {
        if (interval) clearInterval(interval);
      } else {
        resetIdleTimer();
        void refresh();
        startPolling();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    const mq = window.matchMedia('(max-width: 768px)');
    isMobile = mq.matches;
    if (isMobile) sidebarOpen = true;
    function onMqChange(e: MediaQueryListEvent): void {
      isMobile = e.matches;
    }
    mq.addEventListener('change', onMqChange);

    return () => {
      if (interval) clearInterval(interval);
      clearInterval(clock);
      applyPollInterval = null;
      clearTimeout(idleTimer);
      document.removeEventListener('click', resetIdleTimer);
      document.removeEventListener('keydown', resetIdleTimer);
      window.removeEventListener('keydown', handleKeydown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      mq.removeEventListener('change', onMqChange);
      unsubscribeStream();
    };
  });
</script>

<div
  class="flex h-dvh bg-bg text-primary {isResizingSidebar ? 'select-none' : ''}"
  style={isResizingSidebar ? 'cursor: col-resize' : ''}
>
  <!-- Sidebar: a fixed overlay on mobile, static on desktop -->
  {#if !isMobile || sidebarOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    {#if isMobile}
      <div
        class="fixed inset-0 z-40 sidebar-scrim"
        onclick={() => (sidebarOpen = false)}
        onkeydown={(e) => {
          if (e.key === 'Escape') sidebarOpen = false;
        }}
      ></div>
    {/if}
    <aside
      class="{isMobile
        ? 'fixed inset-0 z-50 w-full'
        : ''} bg-sidebar border-r border-edge flex flex-col overflow-hidden shrink-0"
      style={isMobile ? '' : `width: ${sidebarWidth}px`}
    >
      <div class="p-4 border-b border-edge">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1 min-w-0">
            <h1 class="text-base font-semibold truncate">{config.name || 'Painel'}</h1>
            <ProjectSwitcher current={activePrefix} />
          </div>
          <div class="flex items-center gap-2">
            <!--
              I3: a free session, with no issue, no plan and no workflow, in one
              click. No dialog on purpose — every field of `POST /api/sessions`
              is optional and the branch is generated, so asking for any of them
              would be the ceremony this mode exists to skip (§49.2).
            -->
            {#if canOpenSession}
              <button
                type="button"
                class="h-8 px-2 gap-1.5 rounded-md border border-edge bg-surface text-accent text-xs flex items-center justify-center cursor-pointer hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                onclick={() => void handleNewSession()}
                disabled={openingSession}
                title="Nova sessão (Cmd+K)"
                >{#if openingSession}<span class="spinner"></span>{:else}<span
                    class="text-lg leading-none">+</span
                  >{/if} Nova sessão</button
              >
            {/if}
            {#if worktreeMutations}
              <button
                type="button"
                class="h-8 px-2 gap-1.5 rounded-md border border-edge bg-surface text-accent text-xs flex items-center justify-center cursor-pointer hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                onclick={() => openCreateDialog()}
                title={canOpenSession ? 'Novo worktree' : 'Novo worktree (Cmd+K)'}
                ><span class="text-lg leading-none">+</span> Novo</button
              >
            {/if}
            {#if isMobile}
              <button
                type="button"
                class="h-8 w-8 rounded-md border border-edge bg-surface text-muted text-sm flex items-center justify-center cursor-pointer hover:bg-hover"
                onclick={() => (sidebarOpen = false)}
                aria-label="Fechar a barra lateral"
                title="Fechar a barra lateral">&times;</button
              >
            {/if}
          </div>
        </div>
        {#if activeCreateCount > 0}
          <div class="mt-2 flex items-center gap-1 text-[10px] text-muted">
            <span class="spinner"></span>
            {createIndicatorLabel}
          </div>
        {/if}
        <div class="mt-3 flex flex-col gap-2">
          <div class="relative">
            <input
              type="search"
              bind:this={worktreeSearchInput}
              bind:value={searchQuery}
              class="w-full h-7 rounded-md border border-edge bg-surface px-2 pr-6 text-xs text-primary placeholder:text-muted focus:outline-none focus:border-accent"
              placeholder="Buscar worktrees"
              aria-label="Buscar worktrees"
            />
            {#if trimmedWorktreeSearch}
              <button
                type="button"
                class="absolute top-1/2 right-1 -translate-y-1/2 h-4 w-4 flex items-center justify-center rounded text-muted hover:text-primary"
                onclick={() => {
                  searchQuery = '';
                  worktreeSearchInput?.focus();
                }}
                aria-label="Limpar a busca">&times;</button
              >
            {/if}
          </div>
          <div class="flex items-center gap-2 text-[11px] text-muted">
            <label class="flex items-center gap-2 cursor-pointer">
              <Toggle
                checked={showArchivedWorktrees}
                size="sm"
                aria-label="Mostrar worktrees arquivados"
                ontoggle={(checked: boolean) => {
                  showArchivedWorktrees = checked;
                }}
              />
              <span
                >Mostrar arquivados{archivedWorktreeCount > 0
                  ? ` (${archivedWorktreeCount})`
                  : ''}</span
              >
            </label>
          </div>
        </div>
      </div>
      <!--
        One sidebar, two groups (§50.3). "Execuções" is the panel's list of runs
        of the workflow; "Sessões" is the worktree list the port brought. The
        two words are not synonyms and never become one (§50.4, ADR-20).
      -->
      <ExecutionSidebarList
        sessions={filteredSessions}
        selected={selectionKind === 'execution' ? selectedExecutionId : null}
        onselect={selectExecution}
      />
      {#if worktreesAvailable}
        <p class="px-3 pt-2 text-[10px] uppercase tracking-[0.06em] text-muted">Sessões</p>
      {/if}
      <WorktreeList
        rows={visibleWorktreeRows}
        selected={selectionKind === 'session' ? selectedBranch : null}
        removing={removingBranches}
        initializing={openingBranches}
        archiving={archivingBranches}
        {notifiedBranches}
        emptyMessage={worktreeListEmptyMessage}
        onselect={selectSessionRow}
        onclose={closeWorktree}
        onarchive={toggleWorktreeArchived}
        onmerge={(branch) => {
          mergeBranch = branch;
        }}
        onremove={(b) => (removeBranch = b)}
        oneditprofile={openProfileDialog}
        oncreatesubworktree={openSubworktreeDialog}
        canPostToLinear={canCall('postWorktreeToLinear') &&
          config.linearAvailability === 'ready'}
        postingLinear={postingLinearBranches}
        onposttolinear={(branch) => {
          const worktree = worktrees.find((candidate) => candidate.branch === branch);
          if (worktree) requestLinearPost(worktree);
        }}
      />
      {#if canCall('fetchLinearIssues')}
        <LinearPanel
          issues={linearIssues}
          availability={linearAvailability}
          canAssign={canCall('createWorktree')}
          onassign={assignLinear}
          onselect={(issue) => (linearDetail = issue)}
        />
      {/if}
      {#if config.projectDir}
        <SidebarRepoRow
          label={config.mainBranch || 'main'}
          cursorUrl={makeCursorUrl(config.projectDir, sshHost) ?? ''}
          onpull={() => {
            pullMainConfirm = true;
            pullMainForce = false;
            pullMainError = '';
          }}
        />
      {/if}
      {#each (config.linkedRepos ?? []).filter((lr) => lr.dir) as lr (lr.alias)}
        <SidebarRepoRow
          label={lr.alias}
          cursorUrl={makeCursorUrl(lr.dir, sshHost) ?? ''}
          onpull={() => {
            pullLinkedRepoAlias = lr.alias;
            pullLinkedRepoForce = false;
            pullLinkedRepoError = '';
          }}
        />
      {/each}
      {#if !isMobile}
        <div
          class="shrink-0 border-t border-edge px-4 py-3 text-[11px] text-muted flex flex-col gap-1"
        >
          <div class="flex justify-between">
            <span>Navegar</span><kbd class="opacity-60">Cmd+↑/↓</kbd>
          </div>
          <div class="flex justify-between">
            <span>{canOpenSession ? 'Nova sessão' : 'Novo worktree'}</span
            ><kbd class="opacity-60">Cmd+K</kbd>
          </div>
          <div class="flex justify-between">
            <span>Integrar</span><kbd class="opacity-60">Cmd+M</kbd>
          </div>
          <div class="flex justify-between">
            <span>Remover</span><kbd class="opacity-60">Cmd+D</kbd>
          </div>
        </div>
      {/if}
    </aside>
    {#if !isMobile}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (focusable ARIA separator for the keyboard-resizable sidebar) -->
      <div
        class="w-1 shrink-0 cursor-col-resize hover:bg-accent/50 transition-colors"
        class:bg-accent={isResizingSidebar}
        onpointerdown={handleResizeStart}
        onkeydown={handleResizeKeydown}
        role="separator"
        aria-label="Redimensionar a barra lateral"
        aria-orientation="vertical"
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabindex="0"
      ></div>
    {/if}
  {/if}

  <main class="flex-1 min-w-0 flex flex-col overflow-hidden">
    {#if disconnected}
      <div
        class="shrink-0 bg-danger text-accent-text px-4 py-2 text-sm"
        role="alert"
        aria-live="polite"
      >
        Desconectado do servidor. Tentando reconectar…
      </div>
    {/if}
    <TopBar
      name={activeWorktree?.branch ?? null}
      worktree={activeWorktree}
      {sshHost}
      linkedRepos={config.linkedRepos ?? []}
      {isMobile}
      ontogglesidebar={() => (sidebarOpen = !sidebarOpen)}
      onclose={handleClose}
      onarchive={handleArchiveToggle}
      onmerge={() => {
        if (selectedBranch) mergeBranch = selectedBranch;
      }}
      onremove={() => {
        if (selectedBranch) removeBranch = selectedBranch;
      }}
      oneditlabel={openLabelDialog}
      onsettings={() => (showSettingsDialog = true)}
      ondirtyclick={openDiffDialog}
      onCiClick={(pr) => (ciDetailsPr = pr)}
      onReviewsClick={(pr) => (commentReviewPr = pr)}
      onnotificationselect={handleSelectWorktree}
      archiving={isSelectedArchiving}
      onlinearclick={(issue) => (linearDetail = issue)}
    />

    <!--
      One panel (§50.5). The dashboard answers "nothing in particular is
      selected"; everything else — a Task or a free session — is the same
      `ExecutionPanel`, given a snapshot, a workspace, or both.
    -->
    <div class="flex-1 min-w-0 overflow-y-auto">
      {#if awaitingSnapshot && !showDashboard}
        <div class="if-surface"><p class="if-empty">Carregando a execução…</p></div>
      {:else if showDashboard && snapshot === null}
        <div class="if-surface">
          {#if filteredSessions.length > 0 || projects.length > 1 || agentSessions.length > 0}
            <ExecutionsDashboard
              sessions={filteredSessions}
              {projects}
              {agentSessions}
              {selectedProjectId}
              {refreshSeconds}
              {now}
              onselect={selectExecution}
              onselectsession={worktreesAvailable ? selectSessionRow : null}
              onprojectchange={selectProject}
              onrefreshchange={setRefreshSeconds}
            />
          {:else}
            <p class="if-empty">
              Nenhuma execução ativa.{worktreesAvailable
                ? ' Abra uma sessão na barra lateral.'
                : ' Worktrees, sessões e terminal aparecem quando o servidor os anuncia.'}
            </p>
          {/if}
        </div>
      {:else}
        <ExecutionPanel
          {snapshot}
          worktree={activeWorktree ?? null}
          worktrees={taskWorktrees}
          {now}
          events={executionEvents}
          diagnostics={executionDiagnostics}
          config={effectiveConfig}
          {monitorVersion}
          canEditPreferences={preferencesWritable}
          hasPullRequestSync={hasCapability(CAPABILITY.pullRequests)}
          {refreshSeconds}
          {activeTab}
          {logFilter}
          {historyFilter}
          {drawer}
          canDiff={canCall('fetchWorktreeDiff') && activeWorktree !== undefined}
          terminal={terminalAvailable ? terminalPane : null}
          chat={showWebChat ? chatPane : null}
          onrefreshchange={setRefreshSeconds}
          ontabchange={(id) => (activeTab = id)}
          onlogfilterchange={(filter) => (logFilter = filter)}
          onhistoryfilterchange={(filter) => (historyFilter = filter)}
          onopendrawer={(selection) => (drawer = selection)}
          onclosedrawer={closeDrawer}
          onopensettings={() => (showSettingsDialog = true)}
          onopendiff={openDiffDialog}
          onselectworktree={selectWorkspace}
          onopencomments={(pr) => (commentReviewPr = pr)}
          onback={selectionKind === 'execution' &&
          (sessions.length > 1 || projects.length > 1)
            ? () => selectExecution(null)
            : null}
        />
      {/if}
    </div>

    {#if showPaneBar}
      <PaneBar {activePane} panes={paneBarPanes} onselect={handlePaneSelect} />
    {/if}
  </main>
</div>

{#snippet terminalPane()}
  {#if showTabBar && activeWorktree}
    <TabBar
      tabs={activeWorktree.tabs}
      activeTabId={activeWorktree.activeTabId}
      busy={tabBusy}
      oncreate={handleCreateTab}
      onselect={handleSelectTab}
      ondelete={handleDeleteTab}
    />
  {/if}
  {#if canConnect}
    {#key selectedTerminalKey}
      <Terminal
        sessionId={selectedSessionId}
        branch={activeBranch}
        {isMobile}
        initialPane={isMobile ? activePane : undefined}
        {terminalTheme}
        agentTerminalStale={activeWorktree?.agentTerminalStale ?? false}
        refreshingAgentTerminal={isSelectedAgentTerminalRefreshing}
        onrefreshagentterminal={canCall('refreshWorktreeAgentTerminal')
          ? () => {
              if (activeBranch) void handleRefreshAgentTerminal(activeBranch);
            }
          : undefined}
        bind:this={terminalRef}
      />
    {/key}
  {:else if activeWorktree?.creating}
    <div class="flex-1 flex items-center justify-center px-6">
      <div class="flex flex-col items-center gap-3 text-center">
        <span class="spinner" style="width: 24px; height: 24px; border-width: 2px;"></span>
        <div>
          <p class="text-sm text-primary font-medium">
            {activeWorktree.label ?? activeWorktree.branch}
          </p>
        </div>
        <p class="text-xs text-muted">
          {worktreeCreationPhaseLabel(activeWorktree.creationPhase)}
        </p>
      </div>
    </div>
  {:else if activeWorktree}
    <div class="flex-1 flex items-center justify-center px-6">
      <div class="flex flex-col items-center gap-4 text-center">
        <div>
          <p class="text-sm text-primary font-medium">
            {activeWorktree.label ?? activeWorktree.branch}
          </p>
          <p class="text-[10px] text-muted">{activeWorktree.branch}</p>
        </div>
        {#if activeWorktree.agentTerminalStale && canCall('refreshWorktreeAgentTerminal')}
          <button
            type="button"
            class="mt-2 px-5 py-2 rounded-md bg-accent text-accent-text text-sm font-medium cursor-pointer border-none hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            onclick={() => void handleRefreshAgentTerminal(activeWorktree.branch)}
            disabled={isSelectedAgentTerminalRefreshing}
          >
            {#if isSelectedAgentTerminalRefreshing}
              <span class="spinner" style="width: 14px; height: 14px; border-width: 1.5px;"></span>
              Retomando…
            {:else}
              Retomar sessão
            {/if}
          </button>
        {:else if canCall('openWorktree')}
          <button
            type="button"
            class="mt-2 px-5 py-2 rounded-md bg-accent text-accent-text text-sm font-medium cursor-pointer border-none hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            onclick={openSelectedWorktree}
            disabled={isSelectedOpening}
          >
            {#if isSelectedOpening}
              <span class="spinner" style="width: 14px; height: 14px; border-width: 1.5px;"></span>
              Abrindo…
            {:else}
              Abrir sessão
            {/if}
          </button>
        {:else}
          <p class="text-xs text-muted">
            Esta sessão não tem um terminal ativo para acompanhar.
          </p>
        {/if}
      </div>
    </div>
  {:else}
    <p class="if-empty">Nenhuma sessão selecionada.</p>
  {/if}
{/snippet}

{#snippet chatPane()}
  {#key activeBranch}
    <MobileChatSurface
      worktree={activeWorktree as WorktreeInfo}
      onConversationMessageSent={() => void refresh()}
    />
  {/key}
{/snippet}

{#if showCreateDialog}
  <CreateWorktreeDialog
    profiles={config.profiles}
    agents={config.agents}
    defaultProfileName={config.defaultProfileName}
    defaultAgentId={config.defaultAgentId}
    autoNameEnabled={config.autoName}
    initialBranch={assigningLinearIssue?.branchName ?? ''}
    initialPrompt={assigningLinearIssue
      ? `${assigningLinearIssue.title}\n\n${assigningLinearIssue.description ?? ''}`.trim()
      : ''}
    bind:includeRemoteBranches
    {availableBranches}
    {availableBranchesLoading}
    {availableBranchesError}
    {baseBranches}
    {baseBranchesLoading}
    {baseBranchesError}
    {lockedBaseBranch}
    startupEnvs={config.startupEnvs ?? {}}
    oncreate={handleCreate}
    oncancel={() => {
      showCreateDialog = false;
      assigningLinearIssue = null;
      lockedBaseBranch = null;
    }}
  />
{/if}

{#if linearDetail}
  <LinearDetailDialog
    issue={linearDetail}
    canAssign={canCall('createWorktree')}
    onassign={assignLinear}
    onclose={() => (linearDetail = null)}
  />
{/if}

{#if postLinearBranch}
  <LinearPostDialog
    branch={postLinearBranch}
    onsubmit={(target) => sendConversationToLinear(postLinearBranch as string, target)}
    onclose={() => (postLinearBranch = null)}
  />
{/if}

{#if labelBranch && labelWorktree}
  <WorktreeLabelDialog
    branch={labelWorktree.branch}
    initialLabel={labelWorktree.label}
    loading={labelLoading}
    error={labelError}
    onconfirm={(label) => {
      void handleLabelChange(label);
    }}
    onclear={() => {
      void handleLabelChange(null);
    }}
    oncancel={() => {
      labelBranch = null;
      labelError = '';
    }}
  />
{/if}

{#if profileBranch && profileWorktree}
  <WorktreeProfileDialog
    branch={profileWorktree.branch}
    profiles={config.profiles}
    currentProfile={profileWorktree.profile}
    isOpen={profileWorktree.mux === '✓'}
    loading={profileLoading}
    error={profileError}
    onconfirm={(profile) => {
      void handleProfileChange(profile);
    }}
    oncancel={() => {
      profileBranch = null;
      profileError = '';
    }}
  />
{/if}

{#if removeBranch}
  <ConfirmDialog
    message={`Remover o worktree "${removeBranch}"? Esta ação não pode ser desfeita.`}
    onconfirm={handleRemove}
    oncancel={() => (removeBranch = null)}
  />
{/if}

{#if deleteTabConfirm}
  <ConfirmDialog
    message={`Encerrar "${deleteTabConfirm.label}"? Apenas esta sessão derivada e seu processo serão encerrados.`}
    confirmLabel="Encerrar sessão"
    loading={tabBusy}
    onconfirm={confirmDeleteTab}
    oncancel={() => (deleteTabConfirm = null)}
  />
{/if}

{#if mergeBranch}
  <ConfirmDialog
    message={`Integrar o worktree "${mergeBranch}" na branch principal? O worktree é removido depois da integração.`}
    confirmLabel="Integrar"
    variant="accent"
    onconfirm={handleMerge}
    oncancel={() => (mergeBranch = null)}
  />
{/if}

{#if pullMainConfirm}
  <ConfirmDialog
    message={pullMainForce
      ? `Forçar a atualização de "${config.mainBranch || 'main'}"? Commits locais nessa branch são descartados.`
      : `Atualizar "${config.mainBranch || 'main'}" a partir do remoto?`}
    confirmLabel={pullMainForce ? 'Forçar' : 'Atualizar'}
    variant={pullMainForce ? 'danger' : 'accent'}
    loading={pullMainLoading}
    error={pullMainError}
    onconfirm={handlePullMain}
    oncancel={() => {
      pullMainConfirm = false;
      pullMainForce = false;
    }}
  />
{/if}

{#if pullLinkedRepoAlias}
  <ConfirmDialog
    message={pullLinkedRepoForce
      ? `Forçar a atualização de "${pullLinkedRepoAlias}"? Commits locais são descartados.`
      : `Atualizar "${pullLinkedRepoAlias}" a partir do remoto?`}
    confirmLabel={pullLinkedRepoForce ? 'Forçar' : 'Atualizar'}
    variant={pullLinkedRepoForce ? 'danger' : 'accent'}
    loading={pullLinkedRepoLoading}
    error={pullLinkedRepoError}
    onconfirm={handlePullLinkedRepo}
    oncancel={() => {
      pullLinkedRepoAlias = null;
      pullLinkedRepoForce = false;
    }}
  />
{/if}

{#if showSettingsDialog}
  <SettingsDialog
    {currentTheme}
    {useWebChatUi}
    autoRemoveOnMerge={config.autoRemoveOnMerge ?? false}
    linearAutoCreate={config.linearAutoCreateWorktrees}
    linearAvailability={config.linearAvailability}
    onthemechange={(key) => {
      currentTheme = key;
      terminalTheme = terminalThemeFromTokens();
    }}
    onwebchatuichange={(enabled) => {
      useWebChatUi = enabled;
      saveUseWebChatUi(enabled);
    }}
    onautoremovechange={(enabled) => {
      config.autoRemoveOnMerge = enabled;
    }}
    onlinearautocreatechange={(enabled) => {
      config.linearAutoCreateWorktrees = enabled;
    }}
    onagentschange={(agents) => {
      config.agents = agents;
    }}
    onsave={(host) => {
      sshHost = host;
      showSettingsDialog = false;
    }}
    onclose={() => (showSettingsDialog = false)}
  />
{/if}

{#if ciDetailsPr}
  <CiDetailsDialog
    pr={ciDetailsPr}
    branch={selectedWorktree?.branch ?? ''}
    onclose={() => (ciDetailsPr = null)}
    onfixsuccess={() => {
      ciDetailsPr = null;
    }}
  />
{/if}

{#if commentReviewPr}
  <CommentReviewDialog
    pr={commentReviewPr}
    branch={selectedWorktree?.branch ?? ''}
    onclose={() => (commentReviewPr = null)}
    onsendsuccess={() => {
      commentReviewPr = null;
    }}
  />
{/if}

{#if showDiffDialog && selectedBranch && DiffDialogComponent}
  <DiffDialogComponent
    branch={selectedBranch}
    cursorUrl={makeCursorUrl(selectedWorktree?.dir, sshHost)}
    onclose={() => (showDiffDialog = false)}
  />
{/if}

<ToastStack {toasts} ondismiss={handleDismissToast} />

<style>
  .sidebar-scrim {
    background: var(--overlay);
  }
</style>
