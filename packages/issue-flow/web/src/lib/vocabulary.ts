/**
 * The closed vocabulary of `web/AGENTS.md`, in one place.
 *
 * PORT of the label tables of `web/public/app.js`. One term per concept, and
 * an unknown value from the backend falls back **inside** the vocabulary rather
 * than leaking a raw identifier into a badge (ADR-20).
 *
 * `execução` and `sessão` are different things and neither is a synonym of the
 * other — that is the collision §50.4 resolved, and every label below belongs
 * to the execution side of it.
 */

export type ExecutionStatusKey = 'idle' | 'running' | 'completed' | 'failed';

export const EXECUTION_STATUS_KEYS: readonly ExecutionStatusKey[] = [
  'idle',
  'running',
  'completed',
  'failed',
];

export const STATUS_LABELS: Record<ExecutionStatusKey, string> = {
  idle: 'aguardando',
  running: 'executando',
  completed: 'concluído',
  failed: 'falhou',
};

export function isExecutionStatus(value: unknown): value is ExecutionStatusKey {
  return typeof value === 'string' && (EXECUTION_STATUS_KEYS as readonly string[]).includes(value);
}

export function statusLabel(status: unknown): string {
  return isExecutionStatus(status) ? STATUS_LABELS[status] : STATUS_LABELS.idle;
}

/**
 * Reported by the agent's own hooks (ADR-05), never inferred from output.
 *
 * "aguardando você" is the one state in which the execution has stopped making
 * progress until somebody acts — which is why it reads as an alert rather than
 * as one more neutral label beside the execution's status.
 */
export const AGENT_LIFECYCLE_LABELS: Record<string, string> = {
  busy: 'agente trabalhando',
  'awaiting-input': 'aguardando você',
};

/**
 * The dashboard summary counts *execuções* (feminine), so it cannot reuse
 * `STATUS_LABELS`, which qualifies the execution in the masculine the badge
 * uses. Singular first, plural second.
 */
export const SUMMARY_STATUS_ORDER: readonly ExecutionStatusKey[] = [
  'running',
  'idle',
  'completed',
  'failed',
];

export const SUMMARY_STATUS_LABELS: Record<ExecutionStatusKey, readonly [string, string]> = {
  running: ['em execução', 'em execução'],
  idle: ['aguardando', 'aguardando'],
  completed: ['concluída', 'concluídas'],
  failed: ['com falha', 'com falha'],
};

export type PhaseStatusKey = 'pending' | 'running' | 'completed' | 'failed';

/** Textual icon: the colour and the adjacent label already say the state. */
export const PHASE_ICONS: Record<PhaseStatusKey, string> = {
  pending: '○',
  running: '●',
  completed: '✓',
  failed: '✗',
};

export function phaseIcon(status: unknown): string {
  return typeof status === 'string' && status in PHASE_ICONS
    ? PHASE_ICONS[status as PhaseStatusKey]
    : PHASE_ICONS.pending;
}

export type StoryStatusKey = 'backlog' | 'in_progress' | 'in_review' | 'done';

export const STORY_STATUS_LABELS: Record<StoryStatusKey, string> = {
  backlog: 'backlog',
  in_progress: 'em andamento',
  in_review: 'em revisão',
  done: 'concluída',
};

/**
 * The granular `stage`, finer than `STORY_STATUS_LABELS`, derived from real
 * pipeline events (`iteration:start`, `stories:update`, the review phase's
 * `phase:start`/`phase:end`, `correction:cycle`).
 */
export type StoryStageKey =
  | 'pending'
  | 'executing'
  | 'awaiting_review'
  | 'in_review'
  | 'in_correction'
  | 'done'
  | 'failed';

export const STORY_STAGE_LABELS: Record<StoryStageKey, string> = {
  pending: 'aguardando',
  executing: 'em execução',
  awaiting_review: 'aguardando revisão',
  in_review: 'em revisão',
  in_correction: 'em correção',
  done: 'concluída',
  failed: 'falhou',
};

/**
 * Kanban columns, in the order the execution advances through them. The titles
 * are the columns'; the badges keep the lowercase `STORY_STATUS_LABELS`.
 */
export const KANBAN_COLUMNS: readonly { status: StoryStatusKey; title: string }[] = [
  { status: 'backlog', title: 'Backlog' },
  { status: 'in_progress', title: 'Em andamento' },
  { status: 'in_review', title: 'Em revisão' },
  { status: 'done', title: 'Concluído' },
];

/**
 * The verification verdict (U21).
 *
 * `unverified` is a **first-class verdict**, never an absence dressed up as a
 * success: it says a contract ran and could not conclude, and the panel is not
 * allowed to paint that green. `null` is the different statement that no
 * contract has run at all.
 */
export type VerificationVerdict = 'passed' | 'failed' | 'unverified';

export const VERIFICATION_LABELS: Record<VerificationVerdict, string> = {
  passed: 'verificado',
  failed: 'reprovado',
  unverified: 'não verificado',
};

/** Role token per verdict. `unverified` is a warning, never an "ok". */
export const VERIFICATION_TONE: Record<VerificationVerdict, 'ok' | 'warn' | 'error'> = {
  passed: 'ok',
  failed: 'error',
  unverified: 'warn',
};

export function isVerificationVerdict(value: unknown): value is VerificationVerdict {
  return value === 'passed' || value === 'failed' || value === 'unverified';
}

export function configSourceLabel(source: unknown): string {
  const labels: Record<string, string> = {
    default: 'default do Issue Flow',
    global: 'configuração global',
    project: 'configuração do projeto',
    env: 'variável de ambiente',
    cli: 'override da execução',
    fallback: 'fallback',
    recommended: 'política recomendada',
  };
  if (typeof source !== 'string' || source === '') return 'não informado';
  return labels[source] ?? source;
}

/** Journal event types that belong to resilience rather than to the pipeline. */
export const RESILIENCE_EVENTS: ReadonlySet<string> = new Set([
  'retry',
  'agent:attempt',
  'agent:activity',
  'agent:result',
  'failover',
]);

/** One line per journal event. Unknown types fall back to their own name. */
export function historyMessage(event: Record<string, unknown>): string {
  const text = (key: string): string => (typeof event[key] === 'string' ? String(event[key]) : '');
  const num = (key: string): string =>
    typeof event[key] === 'number' ? String(event[key]) : ABSENT_NUMBER;

  switch (event.type) {
    case 'session:start':
      return 'Execução iniciada';
    case 'session:end':
      return `Execução encerrada: ${statusLabel(event.status)}`;
    case 'phase:start':
      return `Fase iniciada: ${text('phase')}`;
    case 'phase:end':
      return `Fase encerrada: ${text('phase')}${event.success === true ? ' (ok)' : ' (falhou)'}`;
    case 'iteration:start':
      return `Iteração ${num('iteration')} iniciada`;
    case 'iteration:end':
      return `Iteração ${num('iteration')} encerrada`;
    case 'retry':
      return `Retry ${num('attempt')}${text('kind') ? `: ${text('kind')}` : ''}`;
    case 'agent:attempt':
      return `Tentativa ${num('attempt')} com ${text('provider')}`;
    case 'agent:activity':
      return `Atividade recebida de ${text('provider')}`;
    case 'agent:result':
      return (
        text('provider') +
        (event.success === true
          ? ' concluiu a tentativa'
          : ` falhou: ${text('failureKind') || 'desconhecida'}`)
      );
    case 'failover':
      return `Failover de ${text('from')} para ${text('to')}${
        text('reason') ? `: ${text('reason')}` : ''
      }`;
    case 'correction:cycle':
      return `Ciclo de correção ${num('cycle')}/${num('maxCycles')}`;
    case 'agent:awaiting-input':
      return `${AGENT_LIFECYCLE_LABELS['awaiting-input']} · ${text('phase')}`;
    case 'agent:awaiting-input-escalated':
      return 'Ninguém respondeu ao agente';
    case 'human:hold':
      return 'Uma pessoa assumiu a execução';
    case 'human:resume':
      return 'Controle devolvido ao agente';
    case 'log':
      return text('message');
    default:
      return typeof event.type === 'string' ? event.type : '';
  }
}

const ABSENT_NUMBER = '—';
