import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvePackageDir } from '../core/prompt-resolver.js';

/**
 * Guards the provider migration: the pipeline talks to Issue providers, never
 * to `gh` directly. A command that shells out again would bypass the resolver
 * and silently break every non-GitHub origin.
 */

const COMMANDS_DIR = fileURLToPath(new URL('../commands', import.meta.url));

/** Forbidden shell-outs, split so a failure names the offending call. */
const FORBIDDEN_GH_CALLS = ['gh issue view', 'gh issue create', 'gh issue close'];

async function readCommandFiles(): Promise<Array<{ name: string; content: string }>> {
  const entries = await readdir(COMMANDS_DIR);
  const files = entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

  return Promise.all(
    files.map(async (name) => ({
      name,
      content: await readFile(join(COMMANDS_DIR, name), 'utf-8'),
    })),
  );
}

/**
 * The array form the commands used before the migration
 * (`execa('gh', ['issue', 'close', ...])`), which no plain-text search for
 * "gh issue close" would ever catch.
 */
const GH_ISSUE_ARGV = /(['"])gh\1\s*,\s*\[\s*(['"])issue\2/;

describe('src/commands does not call gh for Issues', () => {
  it('finds the command files', async () => {
    const files = await readCommandFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_GH_CALLS)('never references %s', async (call) => {
    const offenders = (await readCommandFiles())
      .filter((file) => file.content.includes(call))
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  it('never spawns gh with issue subcommands through an argv array', async () => {
    const offenders = (await readCommandFiles())
      .filter((file) => GH_ISSUE_ARGV.test(file.content))
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });
});

/** Phase templates that receive the resolved Issue instead of fetching it. */
const PHASE_PROMPTS = ['analyze.md', 'prd.md', 'plan.md', 'review.md', 'pr.md'];

/** Every phase template must render the resolved Issue. */
const ISSUE_PLACEHOLDERS = [
  '__ISSUE_TITLE__',
  '__ISSUE_BODY__',
  '__ISSUE_LABELS__',
  '__ISSUE_SOURCE__',
  '__ISSUE_URL__',
];

async function readPrompt(name: string): Promise<string> {
  const promptsDir = resolvePackageDir('prompts');
  expect(promptsDir).not.toBeNull();
  return readFile(join(promptsDir as string, name), 'utf-8');
}

describe('prompt templates consume the resolved Issue', () => {
  it('no template asks the agent to fetch the Issue with gh', async () => {
    const promptsDir = resolvePackageDir('prompts');
    expect(promptsDir).not.toBeNull();

    const names = (await readdir(promptsDir as string)).filter((name) => name.endsWith('.md'));
    expect(names.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of names) {
      const content = await readFile(join(promptsDir as string, name), 'utf-8');
      if (content.includes('gh issue view')) {
        offenders.push(name);
      }
    }

    expect(offenders).toEqual([]);
  });

  it.each(PHASE_PROMPTS)('%s consumes every Issue placeholder', async (name) => {
    const content = await readPrompt(name);
    const missing = ISSUE_PLACEHOLDERS.filter((key) => !content.includes(key));

    expect(missing).toEqual([]);
  });

  it('plan.md fills issueUrl from the resolved reference', async () => {
    const content = await readPrompt('plan.md');

    expect(content).toContain('"issueUrl": "__ISSUE_URL__"');
    // The old rule derived the URL from gh, which no local Issue could satisfy.
    expect(content).not.toContain('<github-issue-url>');
  });

  it('pr.md defers the "Closes #N" reference to the placeholder', async () => {
    const content = await readPrompt('pr.md');

    expect(content).toContain('__ISSUE_CLOSES__');
    expect(content).not.toContain('Closes #__ISSUE_NUMBER__');
  });
});
