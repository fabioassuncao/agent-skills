import { openIssueFlowDatabase } from './index.js';

/** Test-only relational setup kept inside the SQLite boundary. */
export async function seedStoriesForNumbering(input: {
  projectId: string;
  projectRoot: string;
  issueId: string;
  stories: Array<{ id: string; number: number | null; passes?: boolean }>;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const database = await openIssueFlowDatabase({
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  try {
    const now = '2026-08-30T00:00:00.000Z';
    database.transaction(() => {
      database
        .prepare(
          'INSERT OR IGNORE INTO projects (id, root, created_at, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(input.projectId, input.projectRoot, now, now);
      database
        .prepare(
          'INSERT OR IGNORE INTO issues (project_id, id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(input.projectId, input.issueId, 'in_progress', now, now);
      for (const story of input.stories) {
        database
          .prepare(
            'INSERT INTO stories (project_id, issue_id, id, title, priority, passes, story_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            input.projectId,
            input.issueId,
            story.id,
            story.id,
            1,
            story.passes === true ? 1 : 0,
            story.number,
          );
      }
    });
  } finally {
    database.close();
  }
}
