import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrReviewRecommendation } from '../../types.js';
import { getIssueDir } from '../../utils/git.js';

/**
 * Everything the `pr-review` phase produces out of a headless run: the parsed
 * verdict, the Markdown report and the structured index.
 *
 * The Markdown is what a human reads; `index.json` is what an automation reads.
 * Keeping both means a future GitHub publisher never has to re-parse Markdown
 * to know what the review concluded.
 */

/** The Pull Request a report is about. Fields the source never knew stay null. */
export interface PrReviewPullRequest {
  number: number;
  url: string | null;
  title: string | null;
  headBranch: string | null;
}

export type FindingSeverity = 'blocker' | 'high' | 'medium' | 'low';

export interface PrReviewFinding {
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  title: string;
}

export interface PrReviewResult {
  recommendation: PrReviewRecommendation;
  /** Items listed under `BLOCKERS:`; empty when the review found none. */
  blockers: string[];
}

/**
 * Parsing outcome. A failure is explicit rather than an `APPROVE` default:
 * silently approving a Pull Request because the agent's output was malformed
 * is the one failure mode this phase must never have.
 */
export type PrReviewParse = { ok: true; result: PrReviewResult } | { ok: false; error: string };

export interface PrReviewRoundEntry {
  round: number;
  at: string;
  /** null when the output could not be parsed — never coerced to APPROVE. */
  recommendation: PrReviewRecommendation | null;
  headSha: string | null;
  /** Relative to the directory holding index.json. */
  reportPath: string;
  findings: PrReviewFinding[];
}

export interface PrReviewIndex {
  schemaVersion: 1;
  pullRequest: PrReviewPullRequest;
  rounds: PrReviewRoundEntry[];
}

const RECOMMENDATIONS: Record<string, PrReviewRecommendation> = {
  APPROVE: 'APPROVE',
  APPROVE_WITH_SUGGESTIONS: 'APPROVE_WITH_SUGGESTIONS',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
};

/**
 * Read the `<pr-review-result>` block. Tolerant in the spirit of
 * `parseReviewResult()` (`commands/review.ts`): without the block, a bare
 * `RECOMMENDATION:` line in the raw output still counts. Anything else — no
 * recommendation at all, or one outside the enum — is a parse failure.
 */
export function parsePrReviewResult(output: string): PrReviewParse {
  const block = output.match(/<pr-review-result>([\s\S]*?)<\/pr-review-result>/);
  const scope = block?.[1] ?? output;

  const line = scope.match(/RECOMMENDATION:\s*([^\n\r]+)/i);
  if (line?.[1] === undefined) {
    return {
      ok: false,
      error: block
        ? 'The <pr-review-result> block has no RECOMMENDATION line.'
        : 'No <pr-review-result> block and no RECOMMENDATION line in the output.',
    };
  }

  // Markdown emphasis around the verdict is stripped, but never the inner
  // underscores of APPROVE_WITH_SUGGESTIONS.
  const raw = line[1]
    .trim()
    .replace(/[*`]/g, '')
    .replace(/^_+|[_.]+$/g, '')
    .trim();
  const normalized = raw.toUpperCase().replace(/[\s-]+/g, '_');
  const recommendation = RECOMMENDATIONS[normalized];
  if (recommendation === undefined) {
    return {
      ok: false,
      error:
        `Unknown recommendation '${raw}'. ` +
        'Expected APPROVE, APPROVE_WITH_SUGGESTIONS or REQUEST_CHANGES.',
    };
  }

  return { ok: true, result: { recommendation, blockers: parseBlockers(scope) } };
}

/** Items under `BLOCKERS:`, up to the end of the block or the next label. */
function parseBlockers(scope: string): string[] {
  const match = scope.match(/BLOCKERS:([\s\S]*)/i);
  if (match?.[1] === undefined) return [];

  return match[1]
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => /^[-*]\s+/.test(entry))
    .map((entry) => entry.replace(/^[-*]\s+/, '').trim())
    .filter((entry) => entry !== '' && !/^(none|nenhum|n\/a)\.?$/i.test(entry));
}

/** The sections every report carries, in order. */
export const REPORT_SECTIONS = [
  'Executive summary',
  'Strengths',
  'Issues found',
  'Suggested improvements',
  'Architectural observations',
  'Risks identified',
  'Required before merge',
  'Final recommendation',
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

/**
 * Headings that map onto a canonical section. The agent writes prose, so the
 * mapping is deliberately forgiving — an unmatched heading is not dropped, it
 * lands in "Additional notes".
 */
const SECTION_ALIASES: Record<ReportSection, string[]> = {
  'Executive summary': ['executive summary', 'summary', 'overview', 'resumo executivo', 'resumo'],
  Strengths: ['strengths', 'positives', 'highlights', 'what went well', 'pontos positivos'],
  'Issues found': ['issues found', 'issues', 'problems', 'findings', 'problemas encontrados'],
  'Suggested improvements': [
    'suggested improvements',
    'suggestions',
    'improvements',
    'sugestoes de melhoria',
    'sugestoes',
  ],
  'Architectural observations': [
    'architectural observations',
    'architecture',
    'architectural notes',
    'observacoes arquiteturais',
    'arquitetura',
  ],
  'Risks identified': ['risks identified', 'risks', 'riscos identificados', 'riscos'],
  'Required before merge': [
    'required before merge',
    'blockers',
    'must fix before merge',
    'itens obrigatorios antes do merge',
  ],
  'Final recommendation': [
    'final recommendation',
    'recommendation',
    'verdict',
    'recomendacao final',
    'recomendacao',
  ],
};

/** lowercase, unaccented, without list numbering or trailing punctuation. */
function normalizeHeading(heading: string): string {
  return heading
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^\d+[.)]\s*/, '')
    .replace(/[*_`#]/g, '')
    .replace(/[.:;!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchSection(heading: string): ReportSection | null {
  const normalized = normalizeHeading(heading);
  for (const section of REPORT_SECTIONS) {
    if (SECTION_ALIASES[section].includes(normalized)) return section;
  }
  return null;
}

interface SplitBody {
  sections: Map<ReportSection, string>;
  /** Preamble and unrecognized headings, preserved verbatim. */
  extra: string;
}

/**
 * Split the agent's Markdown by heading. Content that matches no canonical
 * section is kept rather than discarded: the report is the record of the
 * review, so nothing the agent wrote may be lost in the rewrite.
 */
function splitBody(body: string): SplitBody {
  const sections = new Map<ReportSection, string>();
  const extra: string[] = [];
  let current: ReportSection | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    buffer = [];
    if (content === '') return;
    if (current === null) {
      extra.push(content);
      return;
    }
    const previous = sections.get(current);
    sections.set(current, previous === undefined ? content : `${previous}\n\n${content}`);
  };

  for (const line of body.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading?.[1] === undefined) {
      buffer.push(line);
      continue;
    }
    flush();
    const section = matchSection(heading[1]);
    current = section;
    if (section === null) {
      buffer.push(line);
    }
  }
  flush();

  return { sections, extra: extra.join('\n\n').trim() };
}

const FINDING_LINE = /^[-*]\s*\[(\w+)\]\s+(.+)$/;
const FINDING_LOCATION = /^(\S+?)(?::(\d+))?\s+[—–-]\s+(.+)$/;

const SEVERITY_ALIASES: Record<string, FindingSeverity> = {
  blocker: 'blocker',
  blocking: 'blocker',
  critical: 'blocker',
  high: 'high',
  major: 'high',
  medium: 'medium',
  moderate: 'medium',
  low: 'low',
  minor: 'low',
  nit: 'low',
};

/**
 * Structured findings out of the report body, from list items written as
 * `- [severity] path/to/file.ts:12 — Title` under "Issues found" and
 * "Required before merge" (the format the prompt asks for). Items in any other
 * shape stay in the Markdown only: the index is a convenience for automations,
 * never the authoritative record.
 */
export function parseFindings(body: string): PrReviewFinding[] {
  const { sections } = splitBody(body);
  const scopes = [sections.get('Issues found'), sections.get('Required before merge')];
  const findings: PrReviewFinding[] = [];

  for (const scope of scopes) {
    if (scope === undefined) continue;
    for (const line of scope.split('\n')) {
      const item = line.trim().match(FINDING_LINE);
      if (item?.[1] === undefined || item[2] === undefined) continue;

      const severity = SEVERITY_ALIASES[item[1].toLowerCase()];
      // Unknown markers stay in the Markdown only — inventing `medium` would
      // mislead any automation that keys off index.json severities.
      if (severity === undefined) continue;

      const rest = item[2].trim();
      const location = rest.match(FINDING_LOCATION);
      if (location?.[1] === undefined || location[3] === undefined) {
        findings.push({ severity, file: null, line: null, title: rest });
        continue;
      }
      findings.push({
        severity,
        file: location[1],
        line: location[2] === undefined ? null : Number(location[2]),
        title: location[3].trim(),
      });
    }
  }

  return dedupeFindings(findings);
}

/** A finding listed both as an issue and as a merge blocker is still one finding. */
function dedupeFindings(findings: PrReviewFinding[]): PrReviewFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.file ?? ''}:${finding.line ?? ''}:${finding.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface BuildReportInput {
  pullRequest: PrReviewPullRequest;
  round: number;
  at: string;
  headSha?: string | null;
  /** null when parsing failed. */
  recommendation: PrReviewRecommendation | null;
  /** Raw headless output. */
  body: string;
  /** Set when `parsePrReviewResult()` failed, so the raw output is kept. */
  parseError?: string | null;
}

/**
 * Assemble the Markdown report: a metadata header, the canonical sections in a
 * fixed order and — when parsing failed — the raw output verbatim, so a
 * malformed run is still auditable instead of being reduced to an exit code.
 */
export function buildReportMarkdown(input: BuildReportInput): string {
  const pr = input.pullRequest;
  const parts: string[] = [`# Pull Request Review — #${pr.number} (round ${input.round})`, ''];

  const heading = pr.url === null ? `#${pr.number}` : `[#${pr.number}](${pr.url})`;
  parts.push(`- **Pull Request:** ${heading}${pr.title === null ? '' : ` — ${pr.title}`}`);
  if (pr.headBranch !== null) parts.push(`- **Head branch:** ${pr.headBranch}`);
  if (input.headSha != null) parts.push(`- **Head SHA:** ${input.headSha}`);
  parts.push(`- **Round:** ${input.round}`);
  parts.push(`- **Reviewed at:** ${input.at}`);
  parts.push(`- **Recommendation:** ${input.recommendation ?? 'UNPARSED'}`);
  parts.push('');

  if (input.parseError != null && input.parseError !== '') {
    parts.push(`> Verdict could not be parsed: ${input.parseError}`, '');
  }

  const { sections, extra } = splitBody(input.body);
  for (const section of REPORT_SECTIONS) {
    parts.push(`## ${section}`, '', sections.get(section) ?? '_Not reported._', '');
  }

  if (input.parseError != null && input.parseError !== '') {
    parts.push('## Raw agent output', '', '```text', input.body.trim(), '```', '');
  } else if (extra !== '') {
    parts.push('## Additional notes', '', extra, '');
  }

  return `${parts.join('\n').trimEnd()}\n`;
}

/** `issues/<N>/pr-review/`, or `issues/pr-<N>/pr-review/` with no issue. */
export async function prReviewDir(opts: { issue?: string; pullRequest: number }): Promise<string> {
  const slug =
    opts.issue === undefined || opts.issue === ''
      ? `pr-${opts.pullRequest}`
      : opts.issue.replace(/^#/, '');
  return join(await getIssueDir(slug), 'pr-review');
}

export function reportFileName(pullRequest: number, round: number): string {
  return `pr-${pullRequest}-round-${round}.md`;
}

const REPORT_FILE = /^pr-(\d+)-round-(\d+)\.md$/;

/**
 * Read `index.json`. Never throws: a missing or corrupt index means "no rounds
 * recorded yet", which the round resolution below cross-checks against the
 * report files actually on disk.
 */
export async function readPrReviewIndex(dir: string): Promise<PrReviewIndex | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'index.json'), 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const index = parsed as Partial<PrReviewIndex>;
    if (!Array.isArray(index.rounds) || typeof index.pullRequest !== 'object') return null;
    return {
      schemaVersion: 1,
      pullRequest: index.pullRequest as PrReviewPullRequest,
      rounds: index.rounds,
    };
  } catch {
    return null;
  }
}

/** Rounds already written for this Pull Request, from the report file names. */
async function roundsOnDisk(dir: string, pullRequest: number): Promise<number[]> {
  try {
    return (await readdir(dir))
      .map((name) => name.match(REPORT_FILE))
      .filter((match): match is RegExpMatchArray => match !== null)
      .filter((match) => Number(match[1]) === pullRequest)
      .map((match) => Number(match[2]));
  } catch {
    return [];
  }
}

/**
 * Which round to write: the explicit `--round <n>`, which rewrites that round,
 * or one past the highest round seen. Both the index and the files on disk are
 * consulted so a corrupt index can never overwrite an existing report.
 */
export async function resolveRound(
  dir: string,
  pullRequest: number,
  explicit?: number,
): Promise<number> {
  if (explicit !== undefined) return explicit;

  const index = await readPrReviewIndex(dir);
  const known = [
    ...(index?.rounds ?? []).map((entry) => entry.round),
    ...(await roundsOnDisk(dir, pullRequest)),
  ];
  return known.length === 0 ? 1 : Math.max(...known) + 1;
}

/**
 * Add or replace a round. Additive by construction: writing round N+1 keeps
 * every earlier entry, and `--round n` replaces exactly one.
 */
export function upsertRound(index: PrReviewIndex, entry: PrReviewRoundEntry): PrReviewIndex {
  const rounds = index.rounds.filter((existing) => existing.round !== entry.round);
  rounds.push(entry);
  rounds.sort((a, b) => a.round - b.round);
  return { ...index, rounds };
}
