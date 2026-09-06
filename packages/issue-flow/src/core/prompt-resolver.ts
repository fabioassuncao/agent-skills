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
      return packaged;
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
    return replacement;
  }

  if (appendix !== null) {
    // One blank line between the two, whatever the packaged prompt ends with,
    // so the appendix never runs into the last paragraph.
    return `${packaged.replace(/\s*$/, '')}\n\n${appendix}`;
  }

  return packaged;
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
  let result = applyConditionalSections(template, vars).replace(/^<!-- Generated[^\n]+-->\n\n/, '');
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(key, value);
  }
  return result;
}
