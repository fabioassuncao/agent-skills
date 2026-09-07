import type { AgentSessionRow, ProjectSummary, SessionSummary } from './types';
import { RESILIENCE_EVENTS, SUMMARY_STATUS_LABELS, SUMMARY_STATUS_ORDER } from './vocabulary';

/**
 * Which execution the panel is looking at, and how the list is grouped.
 *
 * PORT of `resolveView`, `visibleSessions`, `activeWorkGroups` and
 * `renderDashboardSummary` from `web/public/app.js`. Pure on purpose: these are
 * the rules that decide whether the user sees a dashboard or a detail, and they
 * are worth testing without a DOM.
 */

/** The empty string means "every project" — the absence of a filter. */
export const ALL_PROJECTS = '';

export type ExecutionViewMode = 'dashboard' | 'detail';

export interface ExecutionView {
  mode: ExecutionViewMode;
  session: SessionSummary | null;
}

export function visibleSessions(
  sessions: readonly SessionSummary[],
  selectedProjectId: string,
): SessionSummary[] {
  if (selectedProjectId === ALL_PROJECTS) return [...sessions];
  return sessions.filter((session) => session.projectId === selectedProjectId);
}

/**
 * Dashboard or detail, and which execution.
 *
 * Four rules, in this order, and each of them is a decision:
 *
 * 1. An explicit choice that no longer exists is dropped rather than left
 *    pointing at nothing.
 * 2. An explicit choice wins over everything else.
 * 3. **With more than one project the consolidated view is the home screen**,
 *    even with a single execution: it is the view that answers "what is
 *    happening, and in which project" (§47.4).
 * 4. With one project (or none) the behaviour is exactly what it was — zero or
 *    one execution opens the detail directly, two or more open the dashboard.
 */
export function resolveExecutionView(input: {
  sessions: readonly SessionSummary[];
  selectedSessionId: string | null;
  selectedProjectId: string;
  projectCount: number;
}): ExecutionView & { selectedSessionId: string | null } {
  const sessions = visibleSessions(input.sessions, input.selectedProjectId);
  let selectedSessionId = input.selectedSessionId;

  if (selectedSessionId !== null) {
    const stillThere = sessions.some((session) => session.sessionId === selectedSessionId);
    if (!stillThere) selectedSessionId = null;
  }

  if (selectedSessionId !== null) {
    const selected = sessions.find((session) => session.sessionId === selectedSessionId) ?? null;
    return { mode: 'detail', session: selected, selectedSessionId };
  }

  if (input.projectCount > 1) return { mode: 'dashboard', session: null, selectedSessionId };
  if (sessions.length === 0) return { mode: 'detail', session: null, selectedSessionId };
  if (sessions.length === 1) return { mode: 'detail', session: sessions[0], selectedSessionId };
  return { mode: 'dashboard', session: null, selectedSessionId };
}

export interface ActiveWorkGroup {
  id: string | null;
  label: string;
  /** Executions: runs of the workflow over a Task (mode 1 of §49). */
  sessions: SessionSummary[];
  /** Free sessions: a live agent with no run behind it (mode 2 of §49). */
  freeSessions: AgentSessionRow[];
}

export function projectLabel(project: ProjectSummary): string {
  return project.name || project.id;
}

/**
 * The "Trabalho ativo" view: one block per project, in the order the server
 * sent them, each with its executions — **including none**, which is the case
 * that was impossible to represent before the registry existed.
 *
 * A session whose project the registry does not know stays visible, grouped
 * under "Outros projetos": the outside world is the authority over what
 * exists, not the registry (ADR-08).
 */
export function activeWorkGroups(input: {
  sessions: readonly SessionSummary[];
  projects: readonly ProjectSummary[];
  selectedProjectId: string;
  /** Free sessions of §49.2, so a block can show what §49.4 says it shows. */
  agentSessions?: readonly AgentSessionRow[];
}): ActiveWorkGroup[] {
  const groups: ActiveWorkGroup[] = [];
  const byProject = new Map<string, ActiveWorkGroup>();

  for (const project of input.projects) {
    if (input.selectedProjectId !== ALL_PROJECTS && project.id !== input.selectedProjectId) {
      continue;
    }
    const group: ActiveWorkGroup = {
      id: project.id,
      label: projectLabel(project),
      sessions: [],
      freeSessions: [],
    };
    byProject.set(project.id, group);
    groups.push(group);
  }

  const orphans: SessionSummary[] = [];
  for (const session of input.sessions) {
    const group = session.projectId ? byProject.get(session.projectId) : undefined;
    if (group) group.sessions.push(session);
    else orphans.push(session);
  }

  // Only the free ones: a session that belongs to a run is already on screen as
  // that run's card, and listing it twice would be the panel disagreeing with
  // itself about how much work is in flight.
  const orphanFree: AgentSessionRow[] = [];
  for (const session of input.agentSessions ?? []) {
    if (!session.free) continue;
    const group = session.projectId ? byProject.get(session.projectId) : undefined;
    if (group) group.freeSessions.push(session);
    else if (session.projectId === null) orphanFree.push(session);
  }

  if (orphans.length > 0 || orphanFree.length > 0) {
    groups.push({
      id: null,
      label: 'Outros projetos',
      sessions: orphans,
      freeSessions: orphanFree,
    });
  }
  return groups;
}

/**
 * "3 execuções · 2 em execução · 1 concluída".
 *
 * Feminine agreement throughout: the summary counts *execuções*, which is why
 * it cannot reuse the badge's masculine `STATUS_LABELS`.
 */
export function summarizeSessions(sessions: readonly SessionSummary[]): string {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const status = session.status ?? 'idle';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const status of SUMMARY_STATUS_ORDER) {
    const count = counts.get(status);
    if (count === undefined || count === 0) continue;
    const [singular, plural] = SUMMARY_STATUS_LABELS[status];
    parts.push(`${count} ${count === 1 ? singular : plural}`);
  }

  const total = `${sessions.length} ${sessions.length === 1 ? 'execução' : 'execuções'}`;
  return parts.length > 0 ? `${total} · ${parts.join(' · ')}` : total;
}

export type HistoryFilter = 'all' | 'resilience' | 'pipeline';

export interface JournalEntryView {
  seq: number;
  event: Record<string, unknown>;
}

/**
 * The journal, filtered by the two families the panel distinguishes.
 *
 * An entry with no `type` is dropped rather than rendered as a blank row: it is
 * not a pipeline event and it is not a resilience event, so it is not an event.
 */
export function filterHistory(
  entries: readonly JournalEntryView[],
  filter: HistoryFilter,
): JournalEntryView[] {
  return entries.filter((entry) => {
    const type = entry.event?.type;
    if (typeof type !== 'string' || type === '') return false;
    if (filter === 'resilience') return RESILIENCE_EVENTS.has(type);
    if (filter === 'pipeline') return !RESILIENCE_EVENTS.has(type);
    return true;
  });
}

export type LogFilter = 'all' | 'info' | 'warn' | 'error';

export function filterLogs<T extends { level: string }>(
  entries: readonly T[],
  filter: LogFilter,
): T[] {
  return entries.filter((entry) => filter === 'all' || entry.level === filter);
}

/**
 * The refresh interval, as the panel offers it.
 *
 * `0` is "pausar", and it means it: with the push channel open the server would
 * otherwise keep pushing and the control would be decoration.
 */
export const REFRESH_OPTIONS: readonly number[] = [3, 5, 10, 30];
export const REFRESH_PAUSED = 0;
export const REFRESH_STORAGE_KEY = 'issue-flow:refresh-seconds';
export const PROJECT_STORAGE_KEY = 'issue-flow:project';

/** The options actually shown, including a server-suggested value not in the list. */
export function refreshOptions(current: number): number[] {
  const values = [...REFRESH_OPTIONS];
  if (current !== REFRESH_PAUSED && !values.includes(current)) {
    values.push(current);
    values.sort((a, b) => a - b);
  }
  return values;
}
