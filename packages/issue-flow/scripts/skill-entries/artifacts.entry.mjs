import { readFileSync } from 'node:fs';
import { hashIssueContent } from '../../src/issues/hash.ts';
import { parseIssueMarkdown } from '../../src/issues/markdown.ts';
import { issueMetadataSchema, taskPlanSchema } from '../../src/schemas.ts';

const [operation, path, metadataPath] = process.argv.slice(2);
if (operation === '--help') {
  console.log(
    'issue <issue.md> [metadata.json]: parse and hash; validate optional metadata/title/id/hash. plan <tasks.json>: validate the canonical plan schema. Read-only, exit 1 on invalid input.',
  );
} else {
  try {
    if (!path) throw new Error('A file path is required');
    if (operation === 'plan') {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      taskPlanSchema.parse(value);
      const ids = value.userStories.map((story) => story.id);
      if (new Set(ids).size !== ids.length) throw new Error('Duplicate story IDs');
      console.log(JSON.stringify({ valid: true, stories: ids.length }));
    } else if (operation === 'issue') {
      const issue = parseIssueMarkdown(readFileSync(path, 'utf8'));
      if (!issue.title) throw new Error('The first non-empty line must be an H1 title');
      const contentHash = hashIssueContent(issue.title, issue.body);
      if (metadataPath) {
        const metadata = issueMetadataSchema.parse(JSON.parse(readFileSync(metadataPath, 'utf8')));
        if (metadata.title !== issue.title || metadata.contentHash !== contentHash)
          throw new Error('Metadata title/hash differs from issue.md');
        if (/[/\\]/.test(metadata.id) || ['.', '..'].includes(metadata.id))
          throw new Error('Unsafe issue id');
        const expected = /^\d+$/.test(metadata.id) ? Number(metadata.id) : null;
        if (metadata.number !== expected) throw new Error('Metadata number differs from id');
      }
      console.log(JSON.stringify({ ...issue, contentHash }));
    } else throw new Error('Unknown operation');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
