import type { UserStory } from '../../types.js';
import {
  createInitialSnapshot,
  reduceSessionEvent,
  type SessionSnapshot,
} from '../session-state.js';

export function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: 'US-001',
    title: 'First story',
    description: 'Test story',
    acceptanceCriteria: ['Criterion 1'],
    priority: 1,
    passes: false,
    notes: '',
    ...overrides,
  };
}

export function startedSnapshot(): SessionSnapshot {
  return reduceSessionEvent(createInitialSnapshot(), {
    type: 'session:start',
    at: '2026-08-03T12:00:00Z',
    sessionId: 'abc',
    issueNumber: 22,
    issueUrl: 'https://github.com/test/test/issues/22',
    branch: 'feat/22-test',
    baseBranch: 'main',
    phases: ['init', 'prd', 'execute'],
  });
}
