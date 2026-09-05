import { beforeAll, describe, expect, it } from 'vitest';
import { emptyPolicyPlaceholders } from '../../policy/placeholders.js';
import { applyPlaceholders, loadPrompt } from '../prompt-resolver.js';
import { parseFindings, parsePrReviewResult, REPORT_SECTIONS } from './report.js';

/**
 * The prompt and the parser are one contract: the headings it asks for must be
 * the canonical sections, and the blocks it shows as examples must parse. A
 * drift between the two is invisible at runtime — the report simply comes back
 * empty — so it is pinned here.
 */

const PLACEHOLDERS = [
  '__PR_NUMBER__',
  '__ISSUE_NUMBER__',
  '__TASKS_PATH__',
  '__PRD_PATH__',
  '__REPORT_PATH__',
  '__ROUND__',
] as const;

let template: string;

beforeAll(async () => {
  template = await loadPrompt('pr-review');
});

describe('pr-review prompt', () => {
  it('supports every placeholder the phase fills in', () => {
    for (const placeholder of PLACEHOLDERS) {
      expect(template).toContain(placeholder);
    }
  });

  it('leaves no placeholder behind once they are all applied', () => {
    const applied = applyPlaceholders(template, {
      ...Object.fromEntries(PLACEHOLDERS.map((key) => [key, 'x'])),
      // The policy projection every command composes. Empty here, which is the
      // case that must leave no trace of the conditional section behind.
      ...emptyPolicyPlaceholders(),
    });

    expect(applied.match(/__[A-Z][A-Z0-9_]*__/g)).toBeNull();
    expect(applied).not.toContain('Repository policy');
  });

  it('instructs the agent to collect context from gh, git and the plan', () => {
    for (const command of [
      'gh pr view',
      'gh pr diff __PR_NUMBER__ --name-only',
      'gh pr view __PR_NUMBER__ --json files,headRefOid,baseRefOid',
      'git log',
      'CLAUDE.md',
      'README.md',
    ]) {
      expect(template).toContain(command);
    }
  });

  it('does not request unsupported gh diff flags', () => {
    expect(template).not.toContain('gh pr diff __PR_NUMBER__ --stat');
    expect(template).toContain('git diff <base-sha>...<head-sha> -- <path>');
  });

  it('asks for exactly the canonical report sections', () => {
    const headings = [...template.matchAll(/^## (.+)$/gm)]
      .map((match) => match[1] ?? '')
      .filter((heading) => (REPORT_SECTIONS as readonly string[]).includes(heading));

    expect(headings).toEqual([...REPORT_SECTIONS]);
  });

  it('states the criteria for each of the three verdicts', () => {
    for (const verdict of ['APPROVE', 'APPROVE_WITH_SUGGESTIONS', 'REQUEST_CHANGES']) {
      expect(template).toContain(verdict);
    }
  });

  it('shows a result block the parser accepts', () => {
    const parsed = parsePrReviewResult(template);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.recommendation).toBe('APPROVE');
    expect(parsed.result.blockers).toEqual([]);
  });

  it('shows a finding format the indexer accepts', () => {
    const example = template
      .split('\n')
      .find((line) => line.startsWith('- [severity]'))
      ?.replace('[severity]', '[blocker]');

    expect(example).toBeDefined();

    const findings = parseFindings(`## Issues found\n\n${example}\n`);

    expect(findings).toEqual([
      {
        severity: 'blocker',
        file: 'path/to/file.ts',
        line: 123,
        title: 'Short title of the problem',
      },
    ]);
  });
});
