import { afterEach, describe, expect, it } from 'vitest';
import { setOutputCallback } from '../core/verbose.js';
import type { UserStory } from '../types.js';
import { printIterationHeader } from './progress.js';

function makeStory(id: string, passes: boolean): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: '',
    acceptanceCriteria: [],
    priority: Number(id.replace('US-', '')),
    passes,
    notes: '',
  };
}

/** Captures every line printIterationHeader routes through the output callback. */
function capture(): { lines: () => string } {
  const chunks: string[] = [];
  setOutputCallback((line) => chunks.push(line));
  return { lines: () => chunks.join('\n') };
}

describe('printIterationHeader', () => {
  afterEach(() => {
    setOutputCallback(undefined);
  });

  it('marks the story matching activeStoryId as current, even when it is not first in array order', () => {
    const { lines } = capture();
    const stories = [makeStory('US-001', false), makeStory('US-002', false)];

    printIterationHeader(1, undefined, stories, 'US-002');

    const output = lines();
    // US-002 (the active one) gets the "current" [...] icon...
    expect(output).toContain('[...] US-002: Story US-002');
    // ...while US-001, still pending but not active, is "not reached".
    expect(output).toContain('[ ] US-001: Story US-001');
  });

  it('falls back to the first non-passing story when activeStoryId is omitted', () => {
    const { lines } = capture();
    const stories = [makeStory('US-001', false), makeStory('US-002', false)];

    printIterationHeader(1, undefined, stories);

    const output = lines();
    expect(output).toContain('[...] US-001: Story US-001');
    expect(output).toContain('[ ] US-002: Story US-002');
  });

  it('a passing story always shows success, even if it happens to match activeStoryId', () => {
    const { lines } = capture();
    const stories = [makeStory('US-001', true), makeStory('US-002', false)];

    // Defensive case: selectActiveStory() never actually returns a passing
    // story's id in practice, but the header must not misrender if it did.
    printIterationHeader(1, undefined, stories, 'US-001');

    const output = lines();
    expect(output).toContain('[OK] US-001: Story US-001');
    // US-002 is not the (stale) active id, so it is simply "not reached" —
    // not promoted to "current" by default.
    expect(output).toContain('[ ] US-002: Story US-002');
  });
});
