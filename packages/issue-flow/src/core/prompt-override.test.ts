import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conventionPlaceholders, emptyPolicyPlaceholders } from '../policy/placeholders.js';
import {
  applyConditionalSections,
  applyPlaceholders,
  loadPrompt,
  PROMPT_OVERRIDE_DIR,
  resolvePackageDir,
} from './prompt-resolver.js';

let root: string;
const warn = vi.fn();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'issue-flow-prompt-override-'));
  warn.mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeOverride(name: string, content: string): Promise<void> {
  const dir = join(root, PROMPT_OVERRIDE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), content, 'utf-8');
}

describe('loadPrompt overrides', () => {
  it('returns the packaged prompt when the repository declares no override', async () => {
    const packagedDir = resolvePackageDir('prompts');
    const packaged = await readFile(join(packagedDir as string, 'pr.md'), 'utf-8');

    expect(await loadPrompt('pr', { projectRoot: root, warn })).toBe(packaged);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets .issue-flow/prompts/<name>.md replace the packaged prompt', async () => {
    await writeOverride('pr.md', '# Our own PR prompt\n');

    expect(await loadPrompt('pr', { projectRoot: root, warn })).toBe('# Our own PR prompt\n');
  });

  it('appends .issue-flow/prompts/<name>.append.md to the packaged prompt', async () => {
    await writeOverride('pr.append.md', '## House rules\n\nAlways link the ticket.\n');

    const result = await loadPrompt('pr', { projectRoot: root, warn });

    expect(result).toContain('## House rules');
    expect(result.endsWith('Always link the ticket.\n')).toBe(true);
    // The packaged prompt is still there, in front of the appendix.
    expect(result.indexOf('## House rules')).toBeGreaterThan(100);
  });

  it('prefers the replacement over the appendix, and says so', async () => {
    await writeOverride('pr.md', '# Replacement\n');
    await writeOverride('pr.append.md', '# Appendix\n');

    const result = await loadPrompt('pr', { projectRoot: root, warn });

    expect(result).toBe('# Replacement\n');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring the appendix'));
  });

  it('degrades to the packaged prompt when the override cannot be read', async () => {
    // A directory where a file is expected: readable path, unreadable content.
    await mkdir(join(root, PROMPT_OVERRIDE_DIR, 'pr.md'), { recursive: true });

    const packagedDir = resolvePackageDir('prompts');
    const packaged = await readFile(join(packagedDir as string, 'pr.md'), 'utf-8');

    expect(await loadPrompt('pr', { projectRoot: root, warn })).toBe(packaged);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring prompt override'));
  });

  it('still fails loudly for a prompt the package does not ship', async () => {
    await expect(loadPrompt('does-not-exist', { projectRoot: root, warn })).rejects.toThrow(
      'Prompt template not found',
    );
  });
});

describe('applyConditionalSections', () => {
  const template = [
    'Body line.',
    '',
    '<!-- if:__REPO_POLICY__ -->',
    '## Repository policy',
    '',
    '__REPO_POLICY__',
    '<!-- /if -->',
    '',
  ].join('\n');

  it('removes the block, and the blank line before it, when the value is empty', () => {
    expect(applyConditionalSections(template, { __REPO_POLICY__: '' })).toBe('Body line.\n');
  });

  it('treats a whitespace-only value as empty', () => {
    expect(applyConditionalSections(template, { __REPO_POLICY__: '   \n  ' })).toBe('Body line.\n');
  });

  it('keeps the block, without its markers, when the value is present', () => {
    const result = applyConditionalSections(template, { __REPO_POLICY__: 'x' });

    expect(result).toBe('Body line.\n\n## Repository policy\n\n__REPO_POLICY__\n');
    expect(result).not.toContain('<!-- if:');
    expect(result).not.toContain('<!-- /if -->');
  });

  it('ignores keys that are not placeholders', () => {
    expect(applyConditionalSections(template, { notAPlaceholder: '' })).toBe(template);
  });
});

describe('rendered prompts without a policy', () => {
  /** The projection of "this repository declares nothing", on a `main` base. */
  function noPolicy(): Record<string, string> {
    return { ...emptyPolicyPlaceholders(), ...conventionPlaceholders(null, 'main') };
  }

  it('leaves no trace of the conditional sections in any packaged prompt', async () => {
    const promptsDir = resolvePackageDir('prompts') as string;
    const names = (await readdir(promptsDir)).filter((name) => name.endsWith('.md'));

    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      const template = await readFile(join(promptsDir, name), 'utf-8');
      const rendered = applyPlaceholders(template, noPolicy());

      // No heading, no marker, and no unresolved `__REPO_*` left behind for the
      // agent to puzzle over.
      expect(rendered, name).not.toContain('Repository policy');
      expect(rendered, name).not.toContain('<!-- if:');
      expect(rendered, name).not.toContain('<!-- /if -->');
      expect(rendered, name).not.toContain('__REPO_');
      expect(rendered, name).not.toContain('__BASE_BRANCH__');
      expect(rendered, name).not.toContain('__COMMIT_CONVENTION__');
      // And the file's final newline survives.
      expect(rendered.endsWith('\n'), name).toBe(true);
    }
  });

  it('renders the pr prompt exactly as it did before the base branch was resolved', async () => {
    // The non-regression claim of the base-branch fix: on a `main` repository,
    // the three commands are byte for byte the ones that were hard-coded.
    const promptsDir = resolvePackageDir('prompts') as string;
    const template = await readFile(join(promptsDir, 'pr.md'), 'utf-8');

    const rendered = applyPlaceholders(template, noPolicy());

    expect(rendered).toContain('git log main..HEAD --oneline');
    expect(rendered).toContain('git diff main...HEAD --stat');
    expect(rendered).toContain('gh pr create --title "..." --body "..." --base main');
  });

  it('resolves the three commands against a develop base', async () => {
    const promptsDir = resolvePackageDir('prompts') as string;
    const template = await readFile(join(promptsDir, 'pr.md'), 'utf-8');

    const rendered = applyPlaceholders(template, {
      ...emptyPolicyPlaceholders(),
      ...conventionPlaceholders(null, 'develop'),
    });

    expect(rendered).toContain('git log develop..HEAD --oneline');
    expect(rendered).toContain('git diff develop...HEAD --stat');
    expect(rendered).toContain('--base develop');
    // The defect this replaces: `main` often exists in a develop-based
    // repository, so a hard-coded base fails silently rather than loudly.
    expect(rendered).not.toContain('main..HEAD');
    expect(rendered).not.toContain('--base main');
  });

  it('renders the policy section when a policy is projected', async () => {
    const promptsDir = resolvePackageDir('prompts') as string;
    const template = await readFile(join(promptsDir, 'pr.md'), 'utf-8');

    const rendered = applyPlaceholders(template, {
      ...noPolicy(),
      __REPO_POLICY__: '### Base branch\n\ndevelop',
    });

    expect(rendered).toContain('## Repository policy');
    expect(rendered).toContain('### Base branch\n\ndevelop');
    expect(rendered).toContain('takes precedence');
    expect(rendered).not.toContain('<!-- ');
  });

  it('renders the Pull Request template section only when the repository has one', async () => {
    const promptsDir = resolvePackageDir('prompts') as string;
    const template = await readFile(join(promptsDir, 'pr.md'), 'utf-8');

    expect(applyPlaceholders(template, noPolicy())).not.toContain(
      "This repository's Pull Request template",
    );

    const withTemplate = applyPlaceholders(template, {
      ...noPolicy(),
      __REPO_PR_TEMPLATE__: '## What changed\n\n## How was it tested',
    });

    expect(withTemplate).toContain("This repository's Pull Request template");
    expect(withTemplate).toContain('## How was it tested');
    // Deleting a section is what makes automated review read it as unanswered.
    expect(withTemplate).toContain('never delete it');
  });

  it('explains the commit type only when a convention is declared', async () => {
    const promptsDir = resolvePackageDir('prompts') as string;
    const template = await readFile(join(promptsDir, 'execute.md'), 'utf-8');

    expect(applyPlaceholders(template, noPolicy())).not.toContain('## Commit convention');

    const rendered = applyPlaceholders(template, {
      ...noPolicy(),
      __COMMIT_CONVENTION__: 'conventional commits',
    });

    expect(rendered).toContain('## Commit convention');
    expect(rendered).toContain('conventional commits');
  });
});
