import { readFileSync } from 'node:fs';
import { DEFAULT_CONVENTIONS } from '../../src/conventions/defaults.ts';
import { branchName, parseBranch } from '../../src/conventions/git/branch.ts';
import { resolveChangeType } from '../../src/conventions/git/change-type.ts';
import { commitMessage } from '../../src/conventions/git/commit.ts';
import { resolveGitConvention } from '../../src/conventions/git/convention.ts';
import { issueReferenceLines, pullRequestTitle } from '../../src/conventions/git/pull-request.ts';

const operations = {
  branch: branchName,
  parseBranch,
  commit: commitMessage,
  prTitle: pullRequestTitle,
  issueReferences: issueReferenceLines,
  changeType: resolveChangeType,
  convention: resolveGitConvention,
  defaults: () => DEFAULT_CONVENTIONS,
};
if (process.argv.includes('--help')) {
  console.log(
    'Read JSON {operation,input} from stdin. Operations: branch, parseBranch, commit, prTitle, issueReferences, changeType, convention, defaults. Prints JSON; never runs git or writes files.',
  );
} else {
  try {
    const { operation, input } = JSON.parse(readFileSync(0, 'utf8'));
    if (!Object.hasOwn(operations, operation)) throw new Error('Unknown operation');
    console.log(JSON.stringify(operations[operation](input)));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
