import { isThemeKey, THEME_KEYS, type ThemeKey } from './themes';
import type { PrEntry, ProjectInitPhase, WorktreeCreationPhase, WorktreeInfo } from './types';

/**
 * PORT of `frontend/src/lib/utils.ts` @ d8c9d5f (172 lines).
 *
 * Two things changed and both are deliberate:
 *
 * - **Storage keys are namespaced `issue-flow:`**, matching the two keys the
 *   current panel already owns (`issue-flow:theme`, `issue-flow:refresh`). The
 *   upstream's `wt-` prefix would leave two unrelated conventions in the same
 *   origin.
 * - **Every `localStorage` access is wrapped in `try`/`catch`.** The upstream
 *   calls it bare, which throws outright in a browser configured to block site
 *   data — the current panel learned this and the rule is carried over: a
 *   blocked store means the preference does not survive a reload, never that
 *   the panel fails to load.
 *
 * The Tailwind class helpers below return *role* names (`text-danger`,
 * `bg-success/20`), never literal colours: those classes resolve through the
 * `@theme` mapping in `app.css`, which resolves through the Issue Flow tokens
 * (ADR-19).
 */

export const SSH_STORAGE_KEY = 'issue-flow:ssh-host';
export const THEME_STORAGE_KEY = 'issue-flow:theme';
export const LAST_SELECTED_WORKTREE_STORAGE_KEY = 'issue-flow:last-selected-worktree';
export const SIDEBAR_WIDTH_STORAGE_KEY = 'issue-flow:sidebar-width';
export const WEB_CHAT_UI_STORAGE_KEY = 'issue-flow:use-web-chat-ui';
const DEFAULT_SIDEBAR_WIDTH = 220;

/** Read one key, treating a blocked or empty store as "not set". */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write one key; a blocked store is not an error the user needs to see. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked — the preference lasts for this page, and no longer.
  }
}

/**
 * A pull request as the badges read it.
 *
 * `state: null` is a pull request whose state is **not known** — the one the
 * execution snapshot carries, which records that a PR was opened and nothing
 * about what happened to it since. It is deliberately not defaulted to `open`:
 * a PR painted green because nobody asked GitHub is the same class of lie U21
 * forbids for verification. §50.3 puts the WebMux badge on the panel's PR list,
 * and this is what lets one badge serve both without inventing a state.
 */
export type PrBadgeInput = Pick<PrEntry, 'repo' | 'number'> & {
  state: PrEntry['state'] | null;
  isDraft: boolean;
};

export function prLabel(pr: Pick<PrEntry, 'repo' | 'number'>): string {
  return pr.repo ? `${pr.repo} #${pr.number}` : `PR #${pr.number}`;
}

export function isDraftPr(pr: Pick<PrBadgeInput, 'state' | 'isDraft'>): boolean {
  return pr.state === 'open' && pr.isDraft;
}

export function prStateTextClass(pr: Pick<PrBadgeInput, 'state' | 'isDraft'>): string {
  if (pr.state === 'merged') return 'text-merged';
  if (pr.state === 'closed') return 'text-danger';
  if (isDraftPr(pr)) return 'text-muted';
  if (pr.state === null) return 'text-muted';
  return 'text-primary';
}

export function prBadgeClass(pr: Pick<PrBadgeInput, 'state' | 'isDraft'>): string {
  if (pr.state === 'merged') return 'bg-merged/20 text-merged';
  if (pr.state === 'closed') return 'bg-danger/20 text-danger';
  if (isDraftPr(pr)) return 'bg-muted/20 text-muted';
  if (pr.state === 'open') return 'bg-success/20 text-success';
  return 'bg-muted/20 text-muted';
}

export function ciStatusTextClass(ciStatus: PrEntry['ciStatus']): string {
  if (ciStatus === 'failed') return 'text-danger';
  if (ciStatus === 'success') return 'text-success';
  if (ciStatus === 'pending') return 'text-warning';
  return 'text-muted';
}

export function ciStatusDotClass(ciStatus: PrEntry['ciStatus']): string {
  if (ciStatus === 'failed') return 'bg-danger';
  if (ciStatus === 'success') return 'bg-success';
  if (ciStatus === 'pending') return 'bg-warning animate-pulse';
  return 'bg-muted';
}

export function prStatusShellClass(pr: Pick<PrEntry, 'ciChecks' | 'ciStatus' | 'state'>): string {
  if (pr.ciChecks.length > 0) {
    if (pr.ciStatus === 'failed') return 'border-danger/40 bg-danger/5';
    if (pr.ciStatus === 'pending') return 'border-warning/40 bg-warning/5';
    if (pr.ciStatus === 'success') return 'border-success/30 bg-success/5';
  }
  if (pr.state === 'merged') return 'border-merged/35 bg-merged/10';
  if (pr.state === 'closed') return 'border-danger/35 bg-danger/5';
  return 'border-edge bg-surface';
}

export function makeCursorUrl(
  dir: string | null | undefined,
  sshHost: string | null,
): string | null {
  if (!dir) return null;
  if (sshHost) return `cursor://vscode-remote/ssh-remote+${sshHost}${dir}`;
  return `cursor://file${dir}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function searchMatch(needle: string, haystack: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function loadSavedTheme(): ThemeKey {
  const stored = readStored(THEME_STORAGE_KEY);
  return isThemeKey(stored) ? stored : 'system';
}

export function loadSavedSelectedWorktree(): string | null {
  const stored = readStored(LAST_SELECTED_WORKTREE_STORAGE_KEY)?.trim();
  return stored ? stored : null;
}

export function saveSelectedWorktree(branch: string | null): void {
  writeStored(LAST_SELECTED_WORKTREE_STORAGE_KEY, branch);
}

/**
 * Apply a theme choice to the document.
 *
 * `'system'` **removes** `data-theme` rather than writing `'system'`: it is the
 * absence of the attribute that hands the decision back to the `@media` query,
 * and writing the string would leave the panel stuck on whatever the light
 * branch resolves to.
 */
export function applyTheme(key: ThemeKey): void {
  const root = document.documentElement;
  if (key === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', key);
  writeStored(THEME_STORAGE_KEY, key);
}

export function loadSavedSidebarWidth(): number {
  const stored = readStored(SIDEBAR_WIDTH_STORAGE_KEY);
  if (stored) {
    const parsed = Number.parseInt(stored, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

export function saveSidebarWidth(width: number): void {
  writeStored(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
}

export function loadUseWebChatUi(): boolean {
  return readStored(WEB_CHAT_UI_STORAGE_KEY) === 'true';
}

export function saveUseWebChatUi(enabled: boolean): void {
  writeStored(WEB_CHAT_UI_STORAGE_KEY, enabled ? 'true' : null);
}

export function worktreeCreationPhaseLabel(phase: WorktreeCreationPhase | null): string {
  switch (phase) {
    case 'creating_worktree':
      return 'Criando worktree';
    case 'preparing_runtime':
      return 'Preparando runtime';
    case 'running_post_create_hook':
      return 'Executando hook pós-criação';
    case 'starting_session':
      return 'Iniciando sessão';
    case 'reconciling':
      return 'Reconciliando';
    default:
      return 'Criando';
  }
}

export function projectInitPhaseLabel(phase: ProjectInitPhase | null): string {
  switch (phase) {
    case 'creating_config':
      return 'Criando as convenções do projeto';
    case 'analyzing':
      return 'Analisando a estrutura do projeto';
    case 'ready':
      return 'Projeto pronto';
    case 'failed':
      return 'Falha na preparação';
    default:
      return 'Preparando';
  }
}

export function resolveSelectedBranch(
  selectedBranch: string | null,
  selectedWorktree: Pick<WorktreeInfo, 'branch'> | undefined,
  selectableWorktrees: Array<Pick<WorktreeInfo, 'branch' | 'mux'>>,
  hasLoadedWorktrees: boolean,
): string | null {
  if (selectedBranch && selectedWorktree) return selectedBranch;
  if (!hasLoadedWorktrees) return selectedBranch;
  if (selectableWorktrees.length === 0) return null;

  const open = selectableWorktrees.find((worktree) => worktree.mux === '✓');
  return (open ?? selectableWorktrees[0]).branch;
}

export { THEME_KEYS };
