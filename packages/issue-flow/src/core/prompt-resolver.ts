import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Load a prompt template by name from the package's prompts/ directory.
 *
 * @param name - Prompt name without extension (e.g., 'execute', 'analyze')
 * @returns The raw template content with placeholders intact
 */
export async function loadPrompt(name: string): Promise<string> {
  const promptsDir = getPromptsDir();
  const filePath = join(promptsDir, `${name}.md`);

  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Prompt template not found: ${filePath}`);
  }
}

/**
 * Replace placeholders in a prompt template with actual values.
 *
 * Placeholders use the format __KEY__ (e.g., __ISSUE_NUMBER__, __PRD_FILE__).
 */
export function applyPlaceholders(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(key, value);
  }
  return result;
}
