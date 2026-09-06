import { readFile } from 'node:fs/promises';
import { hashIssueContent } from '../issues/hash.js';
import { parseIssueMarkdown } from '../issues/markdown.js';
import { issueMetadataSchema, taskPlanSchema } from '../schemas.js';
import { executionContext, inspectTaskPlan } from './task-plan.js';

/** Explicit files only: never resolves a project, imports storage, or reconciles a run. */
export async function inspectArtifact(operation: string, path?: string, metadataPath?: string) {
  try {
    if (!path || !['plan', 'context', 'issue'].includes(operation))
      throw new Error('Expected plan <tasks.json> or issue <issue.md> [metadata.json]');
    const content = await readFile(path, 'utf8');
    if (operation === 'plan' || operation === 'context') {
      if (metadataPath) throw new Error('plan accepts only one file');
      const value: unknown = JSON.parse(content);
      const inspection = inspectTaskPlan(value);
      if (operation === 'plan' || !inspection.ok) return inspection;
      return {
        schemaVersion: 1 as const,
        ok: true as const,
        data: executionContext(taskPlanSchema.parse(value)),
        errors: [],
      };
    }
    const issue = parseIssueMarkdown(content);
    if (!issue.title) throw new Error('The first non-empty line must be an H1 title');
    const contentHash = hashIssueContent(issue.title, issue.body);
    if (metadataPath) {
      const metadata = issueMetadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')));
      if (metadata.title !== issue.title || metadata.contentHash !== contentHash)
        throw new Error('Metadata title/hash differs from issue.md');
      if (/[/\\]/.test(metadata.id) || ['.', '..'].includes(metadata.id))
        throw new Error('Unsafe issue id');
      const expected = /^\d+$/.test(metadata.id) ? Number(metadata.id) : null;
      if (metadata.number !== expected) throw new Error('Metadata number differs from id');
    }
    return {
      schemaVersion: 1 as const,
      ok: true as const,
      data: { ...issue, contentHash },
      errors: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1 as const,
      ok: false as const,
      data: null,
      errors: [
        {
          code: 'invalid_artifact',
          path: path ?? '',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
