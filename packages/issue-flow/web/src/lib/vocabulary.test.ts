import { describe, expect, it } from 'vitest';
import {
  AGENT_LIFECYCLE_LABELS,
  configSourceLabel,
  historyMessage,
  isVerificationVerdict,
  KANBAN_COLUMNS,
  phaseIcon,
  STORY_STAGE_LABELS,
  STORY_STATUS_LABELS,
  statusLabel,
  VERIFICATION_LABELS,
  VERIFICATION_TONE,
} from './vocabulary';

/**
 * The closed vocabulary (ADR-20).
 *
 * One term per concept, and an unknown value from the backend falls back
 * **inside** the vocabulary rather than leaking a raw identifier onto a badge.
 * `execução` and `sessão` are different things and neither is a synonym of the
 * other — the collision §50.4 resolved.
 */

describe('the execution status', () => {
  it('has one term per state, and no synonyms', () => {
    expect(statusLabel('idle')).toBe('aguardando');
    expect(statusLabel('running')).toBe('executando');
    expect(statusLabel('completed')).toBe('concluído');
    expect(statusLabel('failed')).toBe('falhou');
  });

  it('never leaks an unknown status onto a badge', () => {
    expect(statusLabel('something-new')).toBe('aguardando');
    expect(statusLabel(null)).toBe('aguardando');
    expect(statusLabel(undefined)).toBe('aguardando');
  });

  it('never calls an execution a session', () => {
    const words = Object.values({ ...STORY_STATUS_LABELS, ...STORY_STAGE_LABELS }).join(' ');
    expect(words).not.toMatch(/sess(ão|ões)/i);
  });
});

describe('the agent lifecycle', () => {
  it('says "aguardando você" for the one state that has stopped making progress', () => {
    expect(AGENT_LIFECYCLE_LABELS['awaiting-input']).toBe('aguardando você');
    expect(AGENT_LIFECYCLE_LABELS.busy).toBe('agente trabalhando');
  });
});

describe('the phase icon', () => {
  it('maps each status, and falls back to pending', () => {
    expect(phaseIcon('pending')).toBe('○');
    expect(phaseIcon('running')).toBe('●');
    expect(phaseIcon('completed')).toBe('✓');
    expect(phaseIcon('failed')).toBe('✗');
    expect(phaseIcon('who-knows')).toBe('○');
  });
});

describe('the Kanban columns', () => {
  it('are the four story statuses, in the order the execution advances', () => {
    expect(KANBAN_COLUMNS.map((column) => column.status)).toEqual([
      'backlog',
      'in_progress',
      'in_review',
      'done',
    ]);
    // The column titles are the columns'; the badges keep the lowercase labels.
    expect(KANBAN_COLUMNS.map((column) => column.title)).toEqual([
      'Backlog',
      'Em andamento',
      'Em revisão',
      'Concluído',
    ]);
  });
});

describe('the verification verdict (U21)', () => {
  it('gives unverified the warning role, never the ok role', () => {
    expect(VERIFICATION_TONE.passed).toBe('ok');
    expect(VERIFICATION_TONE.failed).toBe('error');
    expect(VERIFICATION_TONE.unverified).toBe('warn');
  });

  it('names it honestly', () => {
    expect(VERIFICATION_LABELS.unverified).toBe('não verificado');
    expect(VERIFICATION_LABELS.passed).toBe('verificado');
    expect(VERIFICATION_LABELS.failed).toBe('reprovado');
  });

  it('recognises exactly the three verdicts', () => {
    expect(isVerificationVerdict('passed')).toBe(true);
    expect(isVerificationVerdict('failed')).toBe(true);
    expect(isVerificationVerdict('unverified')).toBe(true);
    expect(isVerificationVerdict('ok')).toBe(false);
    expect(isVerificationVerdict(null)).toBe(false);
  });
});

describe('configSourceLabel', () => {
  it('names each layer of the precedence ladder', () => {
    expect(configSourceLabel('cli')).toBe('override da execução');
    expect(configSourceLabel('project')).toBe('configuração do projeto');
    expect(configSourceLabel(null)).toBe('não informado');
    // An unknown source is shown as itself rather than hidden.
    expect(configSourceLabel('novo')).toBe('novo');
  });
});

describe('historyMessage (U11)', () => {
  it('gives every journal event a sentence, in the panel vocabulary', () => {
    expect(historyMessage({ type: 'session:start' })).toBe('Execução iniciada');
    expect(historyMessage({ type: 'session:end', status: 'completed' })).toBe(
      'Execução encerrada: concluído',
    );
    expect(historyMessage({ type: 'phase:end', phase: 'execute', success: true })).toBe(
      'Fase encerrada: execute (ok)',
    );
    expect(historyMessage({ type: 'failover', from: 'a', to: 'b', reason: 'timeout' })).toBe(
      'Failover de a para b: timeout',
    );
    expect(historyMessage({ type: 'agent:awaiting-input-escalated' })).toBe(
      'Ninguém respondeu ao agente',
    );
    expect(historyMessage({ type: 'human:hold' })).toBe('Uma pessoa assumiu a execução');
  });

  it('never says "sessão" for a run of the pipeline', () => {
    // The glossary is explicit: a run of the workflow is an **execução**.
    expect(historyMessage({ type: 'session:start' })).not.toMatch(/sessão/i);
    expect(historyMessage({ type: 'session:end', status: 'failed' })).not.toMatch(/sessão/i);
  });

  it('falls back to the event type rather than to an empty row', () => {
    expect(historyMessage({ type: 'something:new' })).toBe('something:new');
    expect(historyMessage({})).toBe('');
  });
});
