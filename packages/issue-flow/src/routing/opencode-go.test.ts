import { describe, expect, it } from 'vitest';
import { AGENT_PHASES } from '../agents/types.js';
import {
  isOpenCodeGoModel,
  nextOpenCodeGoModel,
  OPENCODE_GO_MODELS,
  openCodeGoEntry,
  resolveOpenCodeGoModel,
} from './opencode-go.js';

describe('resolveOpenCodeGoModel', () => {
  it('covers every phase without picking the specialist by default', () => {
    for (const phase of AGENT_PHASES) {
      const choice = resolveOpenCodeGoModel({ phase });
      expect(choice.model).toMatch(/^opencode-go\//);
      expect(choice.role).not.toBe('specialist');
      expect(choice.reasonCodes).toContain('OPENCODE_GO_POLICY');
    }
  });

  it('uses MiMo for analyze and Luna for merge readiness', () => {
    expect(resolveOpenCodeGoModel({ phase: 'analyze' }).model).toBe(OPENCODE_GO_MODELS.cheap);
    expect(resolveOpenCodeGoModel({ phase: 'analyze', risk: 'high' }).model).toBe(
      OPENCODE_GO_MODELS.default,
    );
    expect(resolveOpenCodeGoModel({ phase: 'pr-review' }).model).toBe(OPENCODE_GO_MODELS.escalate);
    expect(resolveOpenCodeGoModel({ phase: 'prd' }).model).toBe(OPENCODE_GO_MODELS.default);
    expect(resolveOpenCodeGoModel({ phase: 'execute' }).model).toBe(OPENCODE_GO_MODELS.default);
  });

  it('shifts generate docs down and high-risk PRDs up', () => {
    expect(
      resolveOpenCodeGoModel({ phase: 'generate', taskClass: 'docs', risk: 'low' }).model,
    ).toBe(OPENCODE_GO_MODELS.cheap);
    expect(resolveOpenCodeGoModel({ phase: 'prd', taskClass: 'infra', risk: 'high' }).model).toBe(
      OPENCODE_GO_MODELS.escalate,
    );
    expect(resolveOpenCodeGoModel({ phase: 'plan', risk: 'high' }).model).toBe(
      OPENCODE_GO_MODELS.escalate,
    );
    expect(resolveOpenCodeGoModel({ phase: 'plan', profile: 'economy', risk: 'low' }).model).toBe(
      OPENCODE_GO_MODELS.cheap,
    );
  });

  it('picks DeepSeek for cheap coding and Luna for hard execute', () => {
    expect(
      resolveOpenCodeGoModel({ phase: 'execute', taskClass: 'bugfix', risk: 'low' }).model,
    ).toBe(OPENCODE_GO_MODELS.codingCheap);
    expect(resolveOpenCodeGoModel({ phase: 'execute', taskClass: 'test', risk: 'low' }).model).toBe(
      OPENCODE_GO_MODELS.codingCheap,
    );
    expect(
      resolveOpenCodeGoModel({ phase: 'execute', taskClass: 'refactor', risk: 'medium' }).model,
    ).toBe(OPENCODE_GO_MODELS.escalate);
    expect(
      resolveOpenCodeGoModel({ phase: 'execute', taskClass: 'infra', risk: 'low' }).model,
    ).toBe(OPENCODE_GO_MODELS.escalate);
    expect(resolveOpenCodeGoModel({ phase: 'pr', taskClass: 'bugfix', risk: 'low' }).model).toBe(
      OPENCODE_GO_MODELS.codingCheap,
    );
  });

  it('keeps first review on Qwen unless risk is high', () => {
    expect(resolveOpenCodeGoModel({ phase: 'review', risk: 'low' }).model).toBe(
      OPENCODE_GO_MODELS.default,
    );
    expect(resolveOpenCodeGoModel({ phase: 'review', risk: 'high' }).model).toBe(
      OPENCODE_GO_MODELS.escalate,
    );
    expect(
      resolveOpenCodeGoModel({ phase: 'pr-review', taskClass: 'docs', risk: 'low' }).model,
    ).toBe(OPENCODE_GO_MODELS.default);
  });

  it('climbs the review-fix ladder on execute correction cycles', () => {
    expect(resolveOpenCodeGoModel({ phase: 'execute', correctionCycle: 1 }).model).toBe(
      OPENCODE_GO_MODELS.codingCheap,
    );
    expect(resolveOpenCodeGoModel({ phase: 'execute', correctionCycle: 2 }).model).toBe(
      OPENCODE_GO_MODELS.default,
    );
    expect(resolveOpenCodeGoModel({ phase: 'execute', correctionCycle: 3 }).model).toBe(
      OPENCODE_GO_MODELS.escalate,
    );
    expect(resolveOpenCodeGoModel({ phase: 'execute', correctionCycle: 4 }).model).toBe(
      OPENCODE_GO_MODELS.specialist,
    );
  });
});

describe('nextOpenCodeGoModel', () => {
  it('climbs MiMo → Qwen → Luna → Kimi and stops', () => {
    expect(nextOpenCodeGoModel(OPENCODE_GO_MODELS.cheap)).toBe(OPENCODE_GO_MODELS.default);
    expect(nextOpenCodeGoModel(OPENCODE_GO_MODELS.default)).toBe(OPENCODE_GO_MODELS.escalate);
    expect(nextOpenCodeGoModel(OPENCODE_GO_MODELS.escalate)).toBe(OPENCODE_GO_MODELS.specialist);
    expect(nextOpenCodeGoModel(OPENCODE_GO_MODELS.specialist)).toBeNull();
  });

  it('treats DeepSeek as a lateral step onto Qwen', () => {
    expect(nextOpenCodeGoModel(OPENCODE_GO_MODELS.codingCheap)).toBe(OPENCODE_GO_MODELS.default);
    expect(nextOpenCodeGoModel(OPENCODE_GO_MODELS.codingCheap, [OPENCODE_GO_MODELS.default])).toBe(
      OPENCODE_GO_MODELS.escalate,
    );
  });

  it('skips models already tried', () => {
    expect(
      nextOpenCodeGoModel(OPENCODE_GO_MODELS.cheap, [
        OPENCODE_GO_MODELS.default,
        OPENCODE_GO_MODELS.escalate,
      ]),
    ).toBe(OPENCODE_GO_MODELS.specialist);
  });
});

describe('openCodeGoEntry', () => {
  it('recognizes the five Go roles and rejects Anthropic ids', () => {
    expect(isOpenCodeGoModel('anthropic/claude-sonnet-4-5')).toBe(false);
    expect(isOpenCodeGoModel(OPENCODE_GO_MODELS.codingCheap)).toBe(true);
    expect(openCodeGoEntry(OPENCODE_GO_MODELS.specialist)?.tier).toBe('strong');
    expect(openCodeGoEntry('anthropic/claude-sonnet-4-5')).toBeNull();
  });
});
