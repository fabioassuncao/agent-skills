import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashIssueContent } from '../issues/hash.js';
import { parseIssueMarkdown } from '../issues/providers/local.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../..', import.meta.url));
let tree: string;
const valid = '---\nname: sample\ndescription: Inspect a sample when requested.\n---\n# Sample\n';
async function validate() {
  try {
    const result = await run(process.execPath, [
      join(root, 'scripts/validate-skills.mjs'),
      '--tree',
      tree,
    ]);
    return { code: 0, text: result.stdout + result.stderr };
  } catch (err) {
    const result = err as { code: number; stdout: string; stderr: string };
    return { code: result.code, text: result.stdout + result.stderr };
  }
}
async function skill(content = valid) {
  await mkdir(join(tree, 'sample'), { recursive: true });
  await writeFile(join(tree, 'sample/SKILL.md'), content);
}
beforeEach(async () => {
  tree = await mkdtemp(join(tmpdir(), 'skills-validation-'));
});
afterEach(async () => {
  await rm(tree, { recursive: true, force: true });
});

describe('skill validation rejects malformed artifacts', () => {
  it.each([
    ['duplicate YAML keys', valid.replace('description:', 'name: sample\ndescription:')],
    [
      'invalid YAML',
      valid.replace('description: Inspect a sample when requested.', 'description: "unterminated'),
    ],
    ['numeric name', valid.replace('name: sample', 'name: 12')],
    ['wrong directory', valid.replace('name: sample', 'name: another')],
    ['absent description', valid.replace('description: Inspect a sample when requested.\n', '')],
    [
      'blank description',
      valid.replace('description: Inspect a sample when requested.', 'description: "  "'),
    ],
    ['metadata array', valid.replace('---\n#', 'metadata: [one, two]\n---\n#')],
    ['numeric metadata', valid.replace('---\n#', 'metadata:\n  version: 1\n---\n#')],
    ['vendor extension', valid.replace('---\n#', 'model: example\n---\n#')],
    ['experimental allowlist', valid.replace('---\n#', 'allowed-tools: Bash\n---\n#')],
    ['oversized body', valid + 'a\n'.repeat(501)],
    ['missing resource', `${valid}[missing](references/missing.md)`],
    ['reference-style missing link', `${valid}[missing][guide]\n\n[guide]: references/missing.md`],
    ['absolute path', `${valid}[outside](/tmp/example.md)`],
    ['file URI', `${valid}[outside](file:///tmp/example.md)`],
    ['empty compatibility', valid.replace('---\n#', 'compatibility: ""\n---\n#')],
    ['encoded traversal', `${valid}[outside](%2e%2e/secret.md)`],
    ['missing local anchor', `${valid}[section](#not-here)`],
    ['dynamic CLI download', `${valid}Use npx --yes issue-flow@latest policy --json.`],
    ['private state', `${valid}Read ~/.issue-flow/projects/id/session.json.`],
    ['provider invocation', `${valid}Call Bash("pwd").`],
  ])('rejects %s', async (_name, content) => {
    await skill(content);
    expect((await validate()).code).toBe(1);
  });

  it('accepts real YAML, CRLF, reference links, and document-relative resource links', async () => {
    await skill(
      `${valid.replace(
        'description: Inspect a sample when requested.',
        'description: >-\n  Inspect samples.\n  Use when requested.\nmetadata:\n  version: "1"',
      )}[guide][g]\n\n[g]: references/guide.md#usage\n\n[other](references/other.md)\n`.replaceAll(
        '\n',
        '\r\n',
      ),
    );
    await mkdir(join(tree, 'sample/references'));
    await writeFile(
      join(tree, 'sample/references/guide.md'),
      '# Usage\n[Other](other.md#details)\n',
    );
    await writeFile(join(tree, 'sample/references/other.md'), '# Details\n');
    expect(await validate()).toMatchObject({ code: 0 });
  });

  it('checks links inside nested resources', async () => {
    await skill(`${valid}[guide](references/nested/guide.md)`);
    await mkdir(join(tree, 'sample/references/nested'), { recursive: true });
    await writeFile(join(tree, 'sample/references/nested/guide.md'), '[missing](missing.md)');
    expect((await validate()).text).toContain('missing.md does not exist');
  });

  it('rejects a symlink even when its target exists', async () => {
    await skill();
    await symlink(join(tree, 'sample/SKILL.md'), join(tree, 'sample/linked.md'));
    expect((await validate()).text).toContain('symlinks are not portable');
  });

  it('checks prohibited dependencies inside scripts', async () => {
    await skill();
    await mkdir(join(tree, 'sample/scripts'));
    await writeFile(
      join(tree, 'sample/scripts/helper.sh'),
      '#!/bin/sh\nnpx issue-flow@latest policy --json\n',
      { mode: 0o755 },
    );
    expect((await validate()).text).toContain('downloading Issue Flow at runtime is forbidden');
  });

  it('does not accept a directory with no skills', async () => {
    expect((await validate()).code).toBe(1);
  });
});

describe('the distributed artifacts', () => {
  it('each skill passes when copied alone, with its license and exact shared contracts', async () => {
    const built = join(tree, 'built');
    await run(process.execPath, [join(root, 'scripts/build-skills-tree.mjs'), '--out', built]);
    const names = (await readdir(built)).filter((name) => !name.startsWith('.'));
    const shared = await readdir(join(root, 'skills/_shared/contracts'));
    for (const name of names) {
      const isolated = join(tree, 'isolated', name);
      await mkdir(isolated, { recursive: true });
      await cp(join(built, name), join(isolated, name), { recursive: true });
      await expect(
        run(process.execPath, [join(root, 'scripts/validate-skills.mjs'), '--tree', isolated]),
      ).resolves.toBeDefined();
      expect(await readFile(join(isolated, name, 'LICENSE'), 'utf8')).toBe(
        await readFile(join(root, 'LICENSE'), 'utf8'),
      );
      const skillText = await readFile(join(isolated, name, 'SKILL.md'), 'utf8');
      for (const contract of shared) {
        if (!skillText.includes(`references/${contract}`)) continue;
        const generated = await readFile(join(isolated, name, 'references', contract), 'utf8');
        expect(generated.replace(/^<!--[^\n]*-->\n\n/, '')).toBe(
          await readFile(join(root, 'skills/_shared/contracts', contract), 'utf8'),
        );
      }
    }
  }, 30_000);

  it('refuses to delete an unrelated output directory', async () => {
    await writeFile(join(tree, 'keep.txt'), 'human work');
    await expect(
      run(process.execPath, [join(root, 'scripts/build-skills-tree.mjs'), '--out', tree]),
    ).rejects.toThrow();
    expect(await readFile(join(tree, 'keep.txt'), 'utf8')).toBe('human work');
  });

  it('rebuilds its own tree but refuses new unrelated files', async () => {
    const args = [join(root, 'scripts/build-skills-tree.mjs'), '--out', tree];
    await run(process.execPath, args);
    await run(process.execPath, args);
    await writeFile(join(tree, 'keep.txt'), 'human work');
    await expect(run(process.execPath, args)).rejects.toThrow();
    expect(await readFile(join(tree, 'keep.txt'), 'utf8')).toBe('human work');
  });

  it('the bundled hash agrees with the CLI using Node and the Python fallback', async () => {
    const helper = join(root, 'skills/generate-local-issue/scripts/content-hash.sh');
    const python = (await run('/bin/sh', ['-c', 'command -v python3'])).stdout.trim();
    const pythonOnly = join(tree, 'bin');
    await mkdir(pythonOnly);
    await symlink(python, join(pythonOnly, 'python3'));
    for (const raw of [
      '# Title\n\nBody\n',
      '\r\n# Ação 🚀\r\n\r\nOlá\r\n',
      '# Title\n\uFEFFbody\uFEFF',
      '# Title\n\u0085body\u0085',
      '# Title\n\u001cbody\u001c',
      'No heading\r\nBody',
    ]) {
      const file = join(tree, 'issue with spaces.md');
      await writeFile(file, raw);
      const { title, body } = parseIssueMarkdown(raw);
      const expected = hashIssueContent(title, body);
      for (const path of [process.env.PATH, pythonOnly]) {
        const result = await run('/bin/sh', [helper, file], {
          cwd: tree,
          env: { ...process.env, PATH: path },
        });
        expect(result.stdout).toBe(expected);
      }
    }
  });
});
