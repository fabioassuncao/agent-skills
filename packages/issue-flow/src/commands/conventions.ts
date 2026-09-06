import {
  branchName,
  commitMessage,
  DEFAULT_BRANCH_CONVENTION,
  isAllowedType,
  pullRequestTitle,
  resolveChangeType,
  resolveGitConvention,
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
  typeMap: Record<string, string> | null;
  allowedTypes: string[] | null;
  convention: string;
} | null> {
  const policy = await loadRepositoryPolicy();
  if (issue === undefined || issue === '') {
    if (titleFlag === undefined || titleFlag === '') return null;
    return {
      number: null,
      title: titleFlag,
      labels: [],
      typeMap: policy.git.typeMap,
      allowedTypes: policy.git.allowedTypes,
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
      typeMap: policy.git.typeMap,
      allowedTypes: policy.git.allowedTypes,
      convention: policy.git.branchConvention ?? DEFAULT_BRANCH_CONVENTION,
    };
  } catch {
    if (titleFlag === undefined || titleFlag === '') return null;
    return {
      number: /^\d+$/.test(id) ? Number(id) : null,
      title: titleFlag,
      labels: [],
      typeMap: policy.git.typeMap,
      allowedTypes: policy.git.allowedTypes,
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
    typeMap: input.typeMap,
    allowedTypes: input.allowedTypes,
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
  const policy = await loadRepositoryPolicy();
  const convention = resolveGitConvention({ ...policy.git });
  if (!isAllowedType(options.type, convention.commit.types)) {
    printError(`Unknown type "${options.type}".`);
    return 1;
  }
  const issueNumber =
    options.issue !== undefined && /^\d+$/.test(options.issue.replace(/^#/, ''))
      ? Number(options.issue.replace(/^#/, ''))
      : undefined;
  const message = commitMessage({
    format: convention.commit.format,
    type: options.type,
    scope: options.scope,
    subject: options.subject,
    issueNumber,
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
    typeMap: input.typeMap,
    allowedTypes: input.allowedTypes,
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
