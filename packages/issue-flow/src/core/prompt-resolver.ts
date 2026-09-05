import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printWarning } from '../ui/logger.js';
import { getProjectRoot } from '../utils/git.js';

/**
 * Resolve the absolute path to a directory shipped at the package root
 * (e.g. 'prompts', 'web/public'). Works from both source (src/core/) and
 * compiled (dist/) locations by walking up the directory tree until the
 * named folder is found. Returns null when it cannot be located.
 *
 * `startDir` is injectable for tests; it defaults to this module's directory.
 */
export function resolvePackageDir(name: string, startDir?: string): string | null {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = dirname(dir);
  }

  return null;
}

function getPromptsDir(): string {
  const dir = resolvePackageDir('prompts');
  if (dir === null) {
    throw new Error(
      'Could not locate the prompts/ directory. Ensure the package is installed correctly.',
    );
  }
  return dir;
}

/**
 * Directory holding the contracts the prompts include.
 *
 * They are generated from `skills/_shared/contracts/` by
 * `scripts/sync-prompt-contracts.mjs`, which is also what the Agent Skills read
 * out of their own `references/`. One source, two consumers: a rule stated in
 * a prompt and in a skill cannot drift, because neither of them is where it is
 * written.
 */
const CONTRACTS_SUBDIR = '_contracts';

/** Directory a repository puts its own prompt overrides in. */
export const PROMPT_OVERRIDE_DIR = '.issue-flow/prompts';

export interface LoadPromptOptions {
  /**
   * Repository root holding `.issue-flow/prompts/`. Defaults to the git project
   * root; when there is none, no override is looked for.
   */
  projectRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

/** Read a file, answering null for "absent" and for "unreadable". */
async function readOverride(
  filePath: string,
  warn: (message: string) => void,
): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Absence is the common case and says nothing.
      return null;
    }
    // A file the repository *did* write and we cannot read is worth a warning:
    // silently ignoring it would look like the override simply had no effect.
    warn(`Ignoring prompt override ${filePath}: ${(err as Error).message}`);
    return null;
  }
}

/** `<!-- include:name.md -->`, alone on its line. */
const INCLUDE = /^[ \t]*<!--[ \t]*include:([A-Za-z0-9._-]+)[ \t]*-->[ \t]*$/gm;

/**
 * Replace every `<!-- include:<file> -->` with the contract of that name.
 *
 * A missing contract throws rather than resolving to nothing. A prompt that
 * silently loses the section defining `tasks.json`, or the one defining the
 * result block, still runs — and produces output the pipeline cannot parse,
 * with no error pointing at the cause. Failing here is the only way that defect
 * is ever seen.
 *
 * Includes are not recursive: a contract is a leaf. Nesting them would make the
 * rendered size of a prompt impossible to reason about from reading it.
 */
export async function expandIncludes(template: string, promptsDir: string): Promise<string> {
  const names = [...template.matchAll(INCLUDE)].map((match) => match[1] as string);
  if (names.length === 0) return template;

  const contents = new Map<string, string>();
  for (const name of new Set(names)) {
    const filePath = join(promptsDir, CONTRACTS_SUBDIR, name);
    try {
      const body = await readFile(filePath, 'utf-8');
      // Drop the "generated from …" banner: it tells a maintainer not to edit
      // the file, and tells the agent receiving the prompt nothing at all.
      contents.set(name, body.replace(/^<!--[\s\S]*?-->\s*/, '').trim());
    } catch {
      throw new Error(
        `Prompt include not found: ${filePath}. ` +
          'Run `npm run skills:sync` to regenerate the contracts.',
      );
    }
  }

  return template.replace(INCLUDE, (_match, name: string) => contents.get(name) as string);
}

/**
 * Load a prompt template by name, honouring the repository's overrides.
 *
 * Resolution order:
 *
 * 1. `<root>/.issue-flow/prompts/<name>.md` — replaces the packaged prompt;
 * 2. `<root>/.issue-flow/prompts/<name>.append.md` — appended to it;
 * 3. `prompts/<name>.md` of the package.
 *
 * `append` is the recommended form. Replacing a whole prompt makes the
 * repository inherit its maintenance: every improvement shipped by a new
 * release stops reaching it, silently.
 *
 * `<!-- include:<file> -->` is expanded **after** the override is resolved, so
 * an override can use includes too — a repository appending its own section can
 * still pull in the canonical contract instead of restating it.
 *
 * Overrides are opt-in and best-effort — a repository with none, or one that is
 * not a git checkout at all, gets exactly the packaged prompt it got before.
 *
 * @param name - Prompt name without extension (e.g., 'execute', 'analyze')
 * @returns The raw template content with placeholders intact
 */
export async function loadPrompt(name: string, options: LoadPromptOptions = {}): Promise<string> {
  const warn = options.warn ?? printWarning;
  const promptsDir = getPromptsDir();
  const filePath = join(promptsDir, `${name}.md`);

  let packaged: string;
  try {
    packaged = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Prompt template not found: ${filePath}`);
  }

  let root = options.projectRoot;
  if (root === undefined) {
    try {
      root = await getProjectRoot();
    } catch {
      // Not a git repository: no override directory to look in.
      return expandIncludes(packaged, promptsDir);
    }
  }

  const overrideDir = join(root, PROMPT_OVERRIDE_DIR);
  const [replacement, appendix] = await Promise.all([
    readOverride(join(overrideDir, `${name}.md`), warn),
    readOverride(join(overrideDir, `${name}.append.md`), warn),
  ]);

  if (replacement !== null) {
    if (appendix !== null) {
      warn(
        `Both ${name}.md and ${name}.append.md exist in ${PROMPT_OVERRIDE_DIR}; ` +
          'using the replacement and ignoring the appendix.',
      );
    }
    return expandIncludes(replacement, promptsDir);
  }

  if (appendix !== null) {
    // One blank line between the two, whatever the packaged prompt ends with,
    // so the appendix never runs into the last paragraph.
    return expandIncludes(`${packaged.replace(/\s*$/, '')}\n\n${appendix}`, promptsDir);
  }

  return expandIncludes(packaged, promptsDir);
}

/**
 * Drop the conditional sections whose placeholder resolves to nothing, and
 * unwrap the ones that stay.
 *
 * A prompt marks an optional section with HTML comments, which stay invisible
 * if a template is ever read as plain markdown:
 *
 * ```markdown
 * <!-- if:__REPO_POLICY__ -->
 * ## Repository policy
 *
 * __REPO_POLICY__
 * <!-- /if -->
 * ```
 *
 * Separate two consecutive blocks with a blank line. Removal consumes the
 * newline **before** the opening marker, so back-to-back blocks make the second
 * removal eat the line that ended the prompt body — the file loses its trailing
 * newline. `prompt-override.test.ts` asserts that newline for every packaged
 * prompt, which is what catches it.
 *
 * This exists for one reason: a repository that declares no policy must get a
 * prompt that is **byte for byte** the one it got before the policy layer
 * existed. Leaving an empty heading behind would break that, and an empty
 * "Repository policy" section is also actively harmful — it invites the agent
 * to wonder what was supposed to be there.
 */
export function applyConditionalSections(template: string, vars: Record<string, string>): string {
  let result = template;

  for (const [key, value] of Object.entries(vars)) {
    // The key is a placeholder like __REPO_POLICY__: word characters only, so
    // it needs no escaping to be safe inside the pattern below.
    if (!/^__[A-Z0-9_]+__$/.test(key)) continue;

    const block = new RegExp(`\\n?<!-- if:${key} -->\\n([\\s\\S]*?)<!-- /if -->\\n?`, 'g');
    result = result.replace(block, (_match, body: string) =>
      value.trim() === '' ? '' : `\n${body}`,
    );
  }

  return result;
}

/**
 * Replace placeholders in a prompt template with actual values.
 *
 * Placeholders use the format __KEY__ (e.g., __ISSUE_NUMBER__, __PRD_FILE__).
 *
 * Conditional sections are resolved first, so a section whose placeholder is
 * empty disappears entirely instead of rendering as an empty heading.
 */
export function applyPlaceholders(template: string, vars: Record<string, string>): string {
  let result = applyConditionalSections(template, vars);
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(key, value);
  }
  return result;
}
