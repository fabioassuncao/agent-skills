import {
  branchName,
  commitMessage,
  DEFAULT_BRANCH_CONVENTION,
  isChangeType,
  pullRequestTitle,
  resolveChangeType,
} from '../conventions/git/index.js';
import { resolveIssue } from '../issues/resolver.js';
import { loadRepositoryPolicy } from '../policy/index.js';
import { printError } from '../ui/logger.js';

export interface ConventionsBranchOptions {
  issue?: string;
  title?: string;
  json?: boolean;
}

export interface ConventionsCommitOptions {
  type: string;
  scope?: string;
  subject: string;
  issue?: string;
  story?: string;
  breaking?: string;
  json?: boolean;
}

export interface ConventionsPrTitleOptions {
  issue?: string;
  title?: string;
  json?: boolean;
}

async function resolveIssueInput(
  issue: string | undefined,
  titleFlag: string | undefined,
): Promise<{
  number: number | null;
  title: string;
  labels: string[];
  titleConvention: string | null;
  typeMap: Record<string, string> | null;
  convention: string;
} | null> {
  const policy = await loadRepositoryPolicy();
  if (issue === undefined || issue === '') {
    if (titleFlag === undefined || titleFlag === '') return null;
    return {
      number: null,
      title: titleFlag,
      labels: [],
      titleConvention: policy.issues.titleConvention,
      typeMap: policy.git.typeMap,
      convention: policy.git.branchConvention ?? DEFAULT_BRANCH_CONVENTION,
    };
  }

  const id = issue.replace(/^#/, '');
  try {
    const resolved = await resolveIssue(id);
    return {
      number: resolved.issue.number ?? (/^\d+$/.test(id) ? Number(id) : null),
      title: titleFlag === undefined || titleFlag === '' ? resolved.issue.title : titleFlag,
      labels: resolved.issue.labels,
      titleConvention: policy.issues.titleConvention,
      typeMap: policy.git.typeMap,
      convention: policy.git.branchConvention ?? DEFAULT_BRANCH_CONVENTION,
    };
  } catch {
    if (titleFlag === undefined || titleFlag === '') return null;
    return {
      number: /^\d+$/.test(id) ? Number(id) : null,
      title: titleFlag,
      labels: [],
      titleConvention: policy.issues.titleConvention,
      typeMap: policy.git.typeMap,
      convention: policy.git.branchConvention ?? DEFAULT_BRANCH_CONVENTION,
    };
  }
}

export async function runConventionsBranch(options: ConventionsBranchOptions): Promise<number> {
  const input = await resolveIssueInput(options.issue, options.title);
  if (input === null) {
    printError('Provide --issue <n> and/or --title <text>.');
    return 1;
  }
  const change = resolveChangeType({
    labels: input.labels,
    title: input.title,
    titleConvention: input.titleConvention,
    typeMap: input.typeMap,
  });
  const name = branchName({
    type: change.type,
    issueNumber: input.number,
    title: input.title,
    convention: input.convention,
  });
  if (options.json === true) {
    console.log(
      JSON.stringify({ branch: name, type: change.type, source: change.source }, null, 2),
    );
    return 0;
  }
  console.log(name);
  return 0;
}

export async function runConventionsCommit(options: ConventionsCommitOptions): Promise<number> {
  if (!isChangeType(options.type)) {
    printError(`Unknown type "${options.type}".`);
    return 1;
  }
  const issueNumber =
    options.issue !== undefined && /^\d+$/.test(options.issue.replace(/^#/, ''))
      ? Number(options.issue.replace(/^#/, ''))
      : undefined;
  const message = commitMessage({
    type: options.type,
    scope: options.scope,
    subject: options.subject,
    issueNumber,
    storyId: options.story,
    breaking: options.breaking,
  });
  if (options.json === true) {
    console.log(JSON.stringify({ message }, null, 2));
    return 0;
  }
  console.log(message);
  return 0;
}

export async function runConventionsPrTitle(options: ConventionsPrTitleOptions): Promise<number> {
  const input = await resolveIssueInput(options.issue, options.title);
  if (input === null) {
    printError('Provide --issue <n> and/or --title <text>.');
    return 1;
  }
  const change = resolveChangeType({
    labels: input.labels,
    title: input.title,
    titleConvention: input.titleConvention,
    typeMap: input.typeMap,
  });
  const title = pullRequestTitle({
    type: change.type,
    subject: input.title.replace(/^\s*\[[^\]]+\]\s*/, ''),
  });
  if (options.json === true) {
    console.log(JSON.stringify({ title, type: change.type, source: change.source }, null, 2));
    return 0;
  }
  console.log(title);
  return 0;
}
