import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard for the rule in `storage/CLAUDE.md`: an issue directory is
 * resolved by `resolveIssuePaths()` and nowhere else.
 *
 * Removing `getIssueDir()` closed the one alternative that existed; this test is
 * what keeps a new one from appearing. A hand-built `join(root, 'issues', n)`
 * silently skips the legacy migration and reads an empty directory — a failure
 * that surfaces as missing artifacts, not as an error, so convention alone is
 * not enough to prevent it.
 */

const SRC_DIR = join(import.meta.dirname, '..');

/**
 * The only files allowed to name the `issues` path segment: the pure path
 * builder and the legacy-tree reader it migrates from. Test files are exempt —
 * they legitimately build legacy trees as fixtures and assert that nothing was
 * written under `<repoRoot>/issues/`.
 */
const ALLOWED = new Set([join('storage', 'paths.ts'), join('storage', 'compat.ts')]);

/** `'issues'`, `"issues"` or a template segment such as `` `issues/${n}` ``. */
const ISSUE_SEGMENT = /'issues'|"issues"|issues\//;

/**
 * Blank out every comment, preserving offsets so line numbers stay accurate.
 *
 * Without this, prose that merely *mentions* the forbidden shape (the very
 * explanation of why it is forbidden, in a CLAUDE.md-style comment) would fail
 * the guard.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      out += char;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        const closed = source[i] === char;
        i++;
        if (closed) break;
      }
      continue;
    }

    out += char;
    i++;
  }

  return out;
}

/** Offset just past the `)` that closes the call opened before `start`. */
function endOfCall(source: string, start: number): number {
  let depth = 1;
  let i = start;

  while (i < source.length && depth > 0) {
    const char = source[i];

    if (char === "'" || char === '"' || char === '`') {
      i++;
      while (i < source.length && source[i] !== char) {
        i += source[i] === '\\' ? 2 : 1;
      }
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    }

    i++;
  }

  return i;
}

/** 1-based lines holding a `join(...)` that names the `issues` segment itself. */
function handmadeIssuePaths(source: string): number[] {
  const code = stripComments(source);
  const found: number[] = [];
  const call = /\bjoin\s*\(/g;

  let match: RegExpExecArray | null = call.exec(code);
  while (match !== null) {
    const start = match.index + match[0].length;
    if (ISSUE_SEGMENT.test(code.slice(start, endOfCall(code, start)))) {
      found.push(code.slice(0, match.index).split('\n').length);
    }
    match = call.exec(code);
  }

  return found;
}

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC_DIR, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(SRC_DIR, join(entry.parentPath, entry.name)))
    .filter((path) => !path.endsWith('.test.ts'))
    .filter((path) => !ALLOWED.has(path))
    .sort();
}

describe('handmade issue paths', () => {
  it('scans the whole source tree, not an empty list', async () => {
    const files = await sourceFiles();

    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(join('storage', 'resolve.ts'));
    expect(files).not.toContain(join('storage', 'paths.ts'));
    expect(files.some((path) => path.startsWith(`commands${sep}`))).toBe(true);
  });

  it('detects the forbidden shape (guard against a guard that never fires)', () => {
    expect(handmadeIssuePaths("const dir = join(root, 'issues', n);")).toEqual([1]);
    expect(handmadeIssuePaths(`const dir = join(root, \`issues/\${n}\`);`)).toEqual([1]);
    expect(handmadeIssuePaths("const dir = join(\n  root,\n  'issues',\n  n,\n);")).toEqual([1]);

    // Shapes that must stay allowed: the constant, a resolved directory, and
    // prose about the rule.
    expect(handmadeIssuePaths('join(projectDir, ISSUES_DIR_NAME)')).toEqual([]);
    expect(handmadeIssuePaths("join(paths.issuesDir, 'tasks.json')")).toEqual([]);
    expect(handmadeIssuePaths("// never write join(root, 'issues', n)")).toEqual([]);
    expect(handmadeIssuePaths("/**\n * join(root, 'issues', n) is banned.\n */")).toEqual([]);
  });

  it('no file outside src/storage builds an issue path by hand', async () => {
    const offenders: string[] = [];

    for (const path of await sourceFiles()) {
      const source = await readFile(join(SRC_DIR, path), 'utf-8');
      for (const line of handmadeIssuePaths(source)) {
        offenders.push(`${path}:${line}`);
      }
    }

    // Every one of these must go through resolveIssuePaths(issueNumber) —
    // see src/storage/CLAUDE.md.
    expect(offenders).toEqual([]);
  });
});
