import { readFileSync } from 'node:fs';
import { DEFAULT_ISSUE_TYPES } from '../../src/conventions/defaults.ts';
import {
  renderAgentsMd,
  renderClaudeMd,
  renderConventionsDoc,
  renderIssueForm,
  renderIssueTemplateConfig,
  renderLabelsFile,
  renderPullRequestTemplate,
} from '../../src/scaffold/assets.ts';

if (process.argv.includes('--help')) {
  console.log(
    'Read JSON {projectName,hasIssueTypes,documents} from stdin. Print canonical candidate {path,content} assets. Does not inspect or modify a repository. Apply only missing, approved files.',
  );
} else {
  try {
    const {
      projectName = 'Project',
      hasIssueTypes = false,
      documents = ['docs/conventions.md'],
    } = JSON.parse(readFileSync(0, 'utf8'));
    const result = DEFAULT_ISSUE_TYPES.map((type) => ({
      path: `.github/ISSUE_TEMPLATE/${type.order}-${type.slug}.yml`,
      content: renderIssueForm(type),
    }));
    result.push(
      ...[
        ['.github/ISSUE_TEMPLATE/config.yml', renderIssueTemplateConfig()],
        ['.github/PULL_REQUEST_TEMPLATE.md', renderPullRequestTemplate()],
        ['AGENTS.md', renderAgentsMd(projectName, documents)],
        ['CLAUDE.md', renderClaudeMd()],
        ['docs/conventions.md', renderConventionsDoc(hasIssueTypes)],
        ['.github/labels.json', renderLabelsFile(!hasIssueTypes)],
      ].map(([path, content]) => ({ path, content })),
    );
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
