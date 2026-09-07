import { join } from 'node:path';

export const ISSUES_DIR_NAME = 'issues';
export const PRD_FILENAME = 'prd.md';
export const TASKS_FILENAME = 'tasks.json';
export const VERIFY_FILENAME = 'verify.json';
export const RUN_LOG_FILENAME = 'run.log';
export const ROTATED_RUN_LOG_FILENAME = 'run.log.1';

export interface IssuePaths {
  issueDir: string;
  issueFile: string;
  metadataFile: string;
  prdFile: string;
  tasksFile: string;
  progressFile: string;
  analysisFile: string;
  runLogFile: string;
  rotatedRunLogFile: string;
  decompositionFile: string;
  verifyFile: string;
  lastBranchFile: string;
  archiveDir: string;
  prReviewDir: string;
}

/** Validate an identifier before it becomes a path segment. */
export function normalizeIssueIdentifier(issueNumber: string | number): string {
  const normalized = String(issueNumber).trim().replace(/^#/, '');
  if (normalized.length === 0) throw new Error('Issue identifier cannot be empty');
  if (/[/\\]/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`Invalid issue identifier: '${issueNumber}'`);
  }
  return normalized;
}

/** The single canonical layout shared by CLI and portable Skill helpers. */
export function resolveIssueArtifactPaths(
  projectDir: string,
  issueNumber: string | number,
): IssuePaths {
  const issueDir = join(projectDir, ISSUES_DIR_NAME, normalizeIssueIdentifier(issueNumber));
  return {
    issueDir,
    issueFile: join(issueDir, 'issue.md'),
    metadataFile: join(issueDir, 'metadata.json'),
    prdFile: join(issueDir, PRD_FILENAME),
    tasksFile: join(issueDir, TASKS_FILENAME),
    progressFile: join(issueDir, 'progress.txt'),
    analysisFile: join(issueDir, 'analysis.md'),
    runLogFile: join(issueDir, RUN_LOG_FILENAME),
    rotatedRunLogFile: join(issueDir, ROTATED_RUN_LOG_FILENAME),
    decompositionFile: join(issueDir, 'decomposition.md'),
    verifyFile: join(issueDir, VERIFY_FILENAME),
    lastBranchFile: join(issueDir, '.last-branch'),
    archiveDir: join(issueDir, 'archive'),
    prReviewDir: join(issueDir, 'pr-review'),
  };
}
