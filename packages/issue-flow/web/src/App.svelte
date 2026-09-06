<script lang="ts">
  import { type Component, onMount } from 'svelte';
  import CiDetailsDialog from './lib/CiDetailsDialog.svelte';
  import CommentReviewDialog from './lib/CommentReviewDialog.svelte';
  import ConfirmDialog from './lib/ConfirmDialog.svelte';
  import CreateWorktreeDialog from './lib/CreateWorktreeDialog.svelte';
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
    createWorktreeTab,
    deleteWorktreeTab,
    fetchWorktrees,
    hasCapability,
    refreshWorktreeAgentTerminal,
    selectWorktreeTab,
    setWorktreeLabel,
    setWorktreeProfile,
    subscribeSessions,
    activePrefix,
  } from './lib/api';
  import { terminalThemeFromTokens, type ThemeKey } from './lib/themes';
  import { setToastController } from './lib/toast-context';
  import type {
    AppConfig,
    AvailableBranch,
    CreateWorktreeRequest,
    DiffDialogProps,
    PrEntry,
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
   * - **Linear is gone** and so is `MigrationBanner` (§48.1).
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

  const worktreesAvailable = hasCapability(CAPABILITY.worktrees);

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
  let applyPollInterval: ((intervalMs: number) => void) | null = null;
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
  let canConnect = $derived(
    !!selectedBranch && selectedWorktree?.mux === '✓' && !selectedWorktree?.creating,
  );
  let showWebChat = $derived(useWebChatUi && canConnect && supportsWorktreeChat(selectedWorktree));
  // Tabs only mean something for the built-in terminal agents that have a
  // forkable session.
  let showTabBar = $derived(
    canConnect &&
      !showWebChat &&
      (selectedWorktree?.agentName === 'claude' || selectedWorktree?.agentName === 'codex'),
  );
  let isSelectedOpening = $derived(selectedBranch ? openingBranches.has(selectedBranch) : false);
  let isSelectedArchiving = $derived(
    selectedBranch ? archivingBranches.has(selectedBranch) : false,
  );
  let isSelectedAgentTerminalRefreshing = $derived(
    selectedBranch ? refreshingAgentTerminalBranches.has(selectedBranch) : false,
  );
  let selectedSessionId = $derived(
    selectedWorktree?.tabs.find((tab) => tab.tabId === selectedWorktree?.activeTabId)?.sessionId ??
      selectedWorktree?.tabs[0]?.sessionId ??
      null,
  );
  let selectedTerminalKey = $derived(
    selectedBranch
      ? `${selectedBranch}:${selectedSessionId ?? ''}:${terminalSessionRevisions[selectedBranch] ?? 0}`
      : '',
  );
  let pollIntervalMs = $derived(
    hasCreatingWorktrees ? ACTIVE_CREATE_POLL_INTERVAL_MS : DEFAULT_POLL_INTERVAL_MS,
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
    applyPollInterval?.(pollIntervalMs);
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

  $effect(() => {
    // The brand lives in the document title, never in the heading — the same
    // rule the current panel follows.
    document.title = config.name ? `${config.name} · issue-flow` : 'issue-flow';
  });

  let paneBarPanes = $derived.by(() => {
    const count = selectedWorktree?.paneCount ?? 0;
    if (count < 2) return [];
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      label: String(i + 1),
    }));
  });
  let showPaneBar = $derived(isMobile && canConnect && !showWebChat && paneBarPanes.length > 0);

  async function refresh() {
    if (!canCall('fetchWorktrees')) {
      hasLoadedWorktrees = true;
      return;
    }
    try {
      worktrees = await fetchWorktrees();
      hasLoadedWorktrees = true;
      disconnected = false;
    } catch (err) {
      disconnected = true;
      console.error('Falha ao atualizar:', err);
    }
  }

  function openCreateDialog(): void {
    includeRemoteBranches = false;
    lockedBaseBranch = null;
    showCreateDialog = true;
  }

  function openSubworktreeDialog(parentBranch: string): void {
    includeRemoteBranches = false;
    lockedBaseBranch = parentBranch;
    showCreateDialog = true;
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
    const branch = selectedBranch;
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
    const branch = selectedBranch;
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
    const branch = selectedBranch;
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
    const branch = selectedBranch;
    if (!branch || tabBusy) return;
    tabBusy = true;
    try {
      await deleteWorktreeTab(branch, tabId);
      await refresh();
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
      openCreateDialog();
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
        })
        .catch(() => {});
    }
    void refresh();

    let intervalMs = pollIntervalMs;
    let interval: ReturnType<typeof setInterval> | undefined;
    window.addEventListener('keydown', handleKeydown);

    // The push channel. `/api/stream` is the delivery path; the interval below
    // is the safety net for when it drops, not the other way round.
    const unsubscribeStream = subscribeSessions({
      onSessions: () => {
        disconnected = false;
        void refresh();
      },
      onError: () => {
        disconnected = true;
      },
    });

    // Pause the safety net when the tab is hidden or the user has been idle for
    // a minute — the push channel keeps working either way.
    let idleTimer: ReturnType<typeof setTimeout>;
    let idle = false;

    function startPolling(): void {
      if (interval) clearInterval(interval);
      if (document.hidden || idle) return;
      interval = setInterval(refresh, intervalMs);
    }

    applyPollInterval = (nextIntervalMs: number): void => {
      if (intervalMs === nextIntervalMs) return;
      intervalMs = nextIntervalMs;
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

    // The OS theme listener is attached **only** in `system` mode: with an
    // explicit choice the OS must not win. The repaint itself is the media
    // query's job; this only syncs the JS side (and the terminal's palette,
    // which is not CSS).
    const themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    function onSystemThemeChange(): void {
      if (currentTheme !== 'system') return;
      terminalTheme = terminalThemeFromTokens();
    }
    themeQuery.addEventListener('change', onSystemThemeChange);

    return () => {
      if (interval) clearInterval(interval);
      applyPollInterval = null;
      clearTimeout(idleTimer);
      document.removeEventListener('click', resetIdleTimer);
      document.removeEventListener('keydown', resetIdleTimer);
      window.removeEventListener('keydown', handleKeydown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      mq.removeEventListener('change', onMqChange);
      themeQuery.removeEventListener('change', onSystemThemeChange);
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
            {#if worktreesAvailable}
              <button
                type="button"
                class="h-8 px-2 gap-1.5 rounded-md border border-edge bg-surface text-accent text-xs flex items-center justify-center cursor-pointer hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                onclick={() => openCreateDialog()}
                title="Novo worktree (Cmd+K)"
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
      <WorktreeList
        rows={visibleWorktreeRows}
        selected={selectedBranch}
        removing={removingBranches}
        initializing={openingBranches}
        archiving={archivingBranches}
        {notifiedBranches}
        emptyMessage={worktreeListEmptyMessage}
        onselect={handleSelectWorktree}
        onclose={closeWorktree}
        onarchive={toggleWorktreeArchived}
        onmerge={(branch) => {
          mergeBranch = branch;
        }}
        onremove={(b) => (removeBranch = b)}
        oneditprofile={openProfileDialog}
        oncreatesubworktree={openSubworktreeDialog}
      />
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
            <span>Novo worktree</span><kbd class="opacity-60">Cmd+K</kbd>
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
      name={selectedWorktree?.branch ?? null}
      worktree={selectedWorktree}
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
    />

    {#if showWebChat}
      {#key selectedBranch}
        <MobileChatSurface
          worktree={selectedWorktree as WorktreeInfo}
          onConversationMessageSent={() => void refresh()}
        />
      {/key}
    {:else if canConnect}
      {#if showTabBar && selectedWorktree}
        <TabBar
          tabs={selectedWorktree.tabs}
          activeTabId={selectedWorktree.activeTabId}
          busy={tabBusy}
          oncreate={handleCreateTab}
          onselect={handleSelectTab}
          ondelete={handleDeleteTab}
        />
      {/if}
      {#key selectedTerminalKey}
        <Terminal
          sessionId={selectedSessionId}
          branch={selectedBranch}
          {isMobile}
          initialPane={isMobile ? activePane : undefined}
          {terminalTheme}
          agentTerminalStale={selectedWorktree?.agentTerminalStale ?? false}
          refreshingAgentTerminal={isSelectedAgentTerminalRefreshing}
          onrefreshagentterminal={() => {
            if (selectedBranch) void handleRefreshAgentTerminal(selectedBranch);
          }}
          bind:this={terminalRef}
        />
      {/key}
    {:else if selectedWorktree?.creating}
      <div class="flex-1 flex items-center justify-center px-6">
        <div class="flex flex-col items-center gap-3 text-center">
          <span class="spinner" style="width: 24px; height: 24px; border-width: 2px;"></span>
          <div>
            <p class="text-sm text-primary font-medium">
              {selectedWorktree.label ?? selectedWorktree.branch}
            </p>
            {#if selectedWorktree.label}
              <p class="text-[10px] text-muted">{selectedWorktree.branch}</p>
            {/if}
          </div>
          <p class="text-xs text-muted">
            {worktreeCreationPhaseLabel(selectedWorktree.creationPhase)}
          </p>
        </div>
      </div>
    {:else if selectedWorktree}
      <div class="flex-1 flex items-center justify-center px-6">
        <div class="flex flex-col items-center gap-4 text-center">
          <div>
            <p class="text-sm text-primary font-medium">
              {selectedWorktree.label ?? selectedWorktree.branch}
            </p>
            {#if selectedWorktree.label}
              <p class="text-[10px] text-muted">{selectedWorktree.branch}</p>
            {/if}
          </div>
          <div class="flex flex-col items-center gap-1">
            {#if selectedWorktree.profile}
              <span class="text-xs text-muted">Profile: {selectedWorktree.profile}</span>
            {/if}
            {#if selectedWorktree.agentLabel ?? selectedWorktree.agentName}
              <span class="text-xs text-muted"
                >Agente: {selectedWorktree.agentLabel ?? selectedWorktree.agentName}</span
              >
            {/if}
            {#if selectedWorktree.agentName && !supportsWorktreeChat(selectedWorktree)}
              <span class="text-xs text-muted">Este agente roda apenas no terminal.</span>
            {/if}
          </div>
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
        </div>
      </div>
    {:else}
      <div class="flex-1 flex items-center justify-center text-muted text-sm px-6 text-center">
        <p>
          {worktreesAvailable
            ? 'Selecione um worktree na barra lateral para conectar.'
            : 'Este monitor está acompanhando execuções. Worktrees, sessões e terminal aparecem quando o servidor os anuncia.'}
        </p>
      </div>
    {/if}

    {#if showPaneBar}
      <PaneBar {activePane} panes={paneBarPanes} onselect={handlePaneSelect} />
    {/if}
  </main>
</div>

{#if showCreateDialog}
  <CreateWorktreeDialog
    profiles={config.profiles}
    agents={config.agents}
    defaultProfileName={config.defaultProfileName}
    defaultAgentId={config.defaultAgentId}
    autoNameEnabled={config.autoName}
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
      lockedBaseBranch = null;
    }}
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
