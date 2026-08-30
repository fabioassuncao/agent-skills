import { describe, expect, it } from 'vitest';
import type { BenchCampaign } from './real.js';
import { renderCampaignMarkdown } from './report.js';

describe('renderCampaignMarkdown', () => {
  it('redacts secrets and never prints a personal home path', () => {
    const campaign: BenchCampaign = {
      id: 'c1',
      home: '/Users/someone/.issue-flow/bench/c1',
      stop: { reason: 'completed' },
      cells: [
        {
          task: 'small',
          arm: 'baseline',
          tuple: {
            task: 'small',
            harness: 'claude',
            harnessVersion: '2.1.251',
            model: 'sonnet',
            modelVersion: null,
            effort: 'default',
            verification: 'existing-tests',
            strategy: 'pipeline',
            settingSourcesPinned: true,
            strictMcpConfig: false,
            fallbackModelPassed: false,
          },
          repeats: [
            {
              seed: 0,
              taskDurationMs: 100,
              harnessExecutionMs: 80,
              orchestrationOverheadMs: 20,
              timeToAcceptedResultMs: null,
              verdict: 'unverified',
              cost: { status: 'unknown', reason: 'not_reported' },
              attemptCount: 1,
              executionIds: ['e1'],
              invalid: false,
            },
          ],
        },
      ],
    };
    const markdown = renderCampaignMarkdown(campaign, 'baseline');
    expect(markdown).toContain('unverified');
    expect(markdown).toContain('n');
    expect(markdown).toContain('—');
    expect(markdown).not.toContain('sk-ant-secretvalue12');
    expect(markdown).not.toMatch(/ghp_[A-Za-z0-9]+/);
  });
});
