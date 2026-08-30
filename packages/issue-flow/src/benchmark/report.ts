import { hostname } from 'node:os';
import { getGlobalRoot } from '../storage/paths.js';
import { redactSecrets } from '../telemetry/redact.js';
import type { BenchCampaign, CellSummary } from './real.js';
import { summarizeCell } from './real.js';
import type { ComparabilityTuple } from './tuple.js';

function formatMs(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}`;
}

function formatUsd(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

function tupleLine(tuple: ComparabilityTuple): string {
  return [
    tuple.task,
    tuple.harness,
    tuple.harnessVersion,
    tuple.model,
    tuple.modelVersion ?? '—',
    tuple.effort,
    tuple.verification,
    tuple.strategy,
    tuple.settingSourcesPinned ? 'setting-sources:pinned' : 'setting-sources:unpinned',
    tuple.strictMcpConfig ? 'strict-mcp' : 'mcp:default',
    tuple.fallbackModelPassed ? 'INVALID:fallback-model' : 'fallback:none',
  ].join(' × ');
}

function verdictCounts(summary: CellSummary): string {
  return `passed=${summary.verdicts.passed} failed=${summary.verdicts.failed} unverified=${summary.verdicts.unverified}`;
}

function scrubPaths(text: string): string {
  const home = getGlobalRoot();
  return text.split(home).join('<issue-flow-home>');
}

export function renderCampaignMarkdown(campaign: BenchCampaign, subject: string): string {
  const lines: string[] = [
    `# Harness campaign — ${subject}`,
    '',
    `> **Research document.** Campaign \`${campaign.id}\`.`,
    `> Machine: \`${hostname()}\`. Node ${process.version}.`,
    campaign.stop.reason === 'completed'
      ? '> Status: complete.'
      : `> Status: **partial** — stopped on \`${campaign.stop.reason}\` (spent ${campaign.stop.spent}, ceiling ${campaign.stop.ceiling}). Results below are the repeats that finished; they are not a silently truncated table.`,
    '',
    '`time-to-accepted-result` is null when the verdict is not `passed`. Cost `unknown` is never summed as zero.',
    '',
    '## Cells',
    '',
    '| Task | Arm | n | duration p50/p95 (ms) | harness p50/p95 | overhead p50/p95 | accepted p50/p95 | cost p50/p95 | verdicts | invalid |',
    '|---|---|---:|---|---|---|---|---|---|---|',
  ];

  for (const cell of campaign.cells) {
    const summary = summarizeCell(cell);
    const invalid = cell.repeats.some((repeat) => repeat.invalid);
    lines.push(
      `| ${cell.task} | ${cell.arm} | ${summary.n} | ${formatMs(summary.taskDurationMs.p50)} / ${formatMs(summary.taskDurationMs.p95)} | ${formatMs(summary.harnessExecutionMs.p50)} / ${formatMs(summary.harnessExecutionMs.p95)} | ${formatMs(summary.orchestrationOverheadMs.p50)} / ${formatMs(summary.orchestrationOverheadMs.p95)} | ${formatMs(summary.timeToAcceptedResultMs.p50)} / ${formatMs(summary.timeToAcceptedResultMs.p95)} | ${formatUsd(summary.cost.reportedP50)} / ${formatUsd(summary.cost.reportedP95)} | ${verdictCounts(summary)} | ${invalid ? 'yes' : 'no'} |`,
    );
  }

  lines.push('', '## Comparability tuples', '');
  for (const cell of campaign.cells) {
    lines.push(`- **${cell.task} / ${cell.arm}**: \`${tupleLine(cell.tuple)}\``);
  }
  lines.push('');
  return redactSecrets(scrubPaths(lines.join('\n')));
}
