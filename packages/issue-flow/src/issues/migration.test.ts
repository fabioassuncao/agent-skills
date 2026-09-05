import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expandIncludes, resolvePackageDir } from '../core/prompt-resolver.js';
import { DRAFT_TAG } from './draft.js';

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

/**
 * The prompt as an agent receives it — `<!-- include:… -->` already replaced.
 *
 * A rule can live in the prompt or in the contract it includes, and which one
 * is an implementation detail of where it is maintained. Reading the raw file
 * would assert on that detail instead of on the prompt.
 */
async function readPrompt(name: string): Promise<string> {
  const promptsDir = resolvePackageDir('prompts');
  expect(promptsDir).not.toBeNull();
  const raw = await readFile(join(promptsDir as string, name), 'utf-8');
  return expandIncludes(raw, promptsDir as string);
}

describe('prompt templates consume the resolved Issue', () => {
  it.each(FORBIDDEN_GH_CALLS)('no template asks the agent to run %s', async (call) => {
    const promptsDir = resolvePackageDir('prompts');
    expect(promptsDir).not.toBeNull();

    const names = (await readdir(promptsDir as string)).filter((name) => name.endsWith('.md'));
    expect(names.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of names) {
      const content = await readFile(join(promptsDir as string, name), 'utf-8');
      if (content.includes(call)) {
        offenders.push(name);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('generate.md emits a parseable draft instead of creating the Issue', async () => {
    const content = await readPrompt('generate.md');

    expect(content).toContain(`<${DRAFT_TAG}>`);
    expect(content).toContain(`</${DRAFT_TAG}>`);
    expect(content).toContain('__USER_PROMPT__');
    // The draft is what gets captured now; no URL is fished out of the prose.
    expect(content).not.toContain('Output the issue URL');
  });

  it.each(PHASE_PROMPTS)('%s consumes every Issue placeholder', async (name) => {
    const content = await readPrompt(name);
    const missing = ISSUE_PLACEHOLDERS.filter((key) => !content.includes(key));

    expect(missing).toEqual([]);
  });

  it('plan.md fills issueUrl from the resolved reference', async () => {
    const content = (await readPrompt('plan.md')).split(/\s+/).join(' ');

    // The old rule derived the URL from gh, which no local Issue could satisfy.
    // What replaced it: the reference is already resolved, and the agent copies
    // it rather than reconstructing one.
    expect(content).toContain('`issueUrl` is `__ISSUE_URL__`');
    expect(content).toContain('Use it verbatim and never derive it yourself');
    expect(content).not.toContain('<github-issue-url>');
  });

  it('pr.md defers the "Closes #N" reference to the placeholder', async () => {
    const content = await readPrompt('pr.md');

    expect(content).toContain('__ISSUE_REFERENCE__');
    expect(content).not.toContain('Closes #__ISSUE_NUMBER__');
  });
});
