import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument } from 'yaml';
import { artifactRoot, assemble, compare, contained, files } from './skills-build.mjs';

export function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('Missing YAML frontmatter');
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join('; '));
  return { data: doc.toJS({ maxAliasCount: 0 }), body: text.slice(match[0].length) };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function anchor(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
    .replace(/\s/g, '-');
}

function anchors(text) {
  const result = new Set();
  const counts = new Map();
  walk(fromMarkdown(text), (node) => {
    if (node.type !== 'heading') return;
    let title = '';
    walk(node, (part) => {
      if (part.type === 'text' || part.type === 'inlineCode') title += part.value;
    });
    const slug = anchor(title);
    const count = counts.get(slug) ?? 0;
    result.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  });
  return result;
}

export async function validateSkill(root) {
  const errors = [];
  const name = root.split(/[\\/]/).pop();
  const paths = await files(root).catch((e) => {
    errors.push(e.message);
    return [];
  });
  const entry = await readFile(join(root, 'SKILL.md'), 'utf8').catch(() => '');
  try {
    const { data, body } = frontmatter(entry);
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Frontmatter must be a mapping');
    const allowed = ['name', 'description', 'license', 'compatibility', 'metadata'];
    for (const key of Object.keys(data))
      if (!allowed.includes(key)) errors.push(`Unsupported core field: ${key}`);
    if (
      typeof data.name !== 'string' ||
      data.name.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) ||
      data.name !== name
    )
      errors.push('name must match directory and Agent Skills naming rules');
    for (const [key, max, required] of [
      ['description', 1024, true],
      ['compatibility', 500, false],
      ['license', Infinity, false],
    ]) {
      if (!required && data[key] === undefined) continue;
      if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > max)
        errors.push(`Invalid ${key}`);
    }
    if (
      data.metadata !== undefined &&
      (!data.metadata ||
        typeof data.metadata !== 'object' ||
        Array.isArray(data.metadata) ||
        Object.values(data.metadata).some((v) => typeof v !== 'string'))
    )
      errors.push('metadata must map strings to strings');
    if (!body.trim()) errors.push('Empty instructions');
    if (entry.split('\n').length >= 500)
      errors.push('Editorial limit: keep SKILL.md below 500 lines');
  } catch (e) {
    errors.push(e.message);
  }

  const canonicalRoot = await realpath(root);
  async function checkTarget(file, target) {
    if (/^(?:https?:|mailto:)/i.test(target)) return;
    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      errors.push(`${file}: invalid URL ${target}`);
      return;
    }
    const [path, fragment] = decoded.split('#');
    if (/^(?:[a-z]+:|\/|\\|~)/i.test(path)) {
      errors.push(`${file}: external path ${target}`);
      return;
    }
    const dest = resolve(dirname(join(root, file)), path || '.');
    const actual = path ? dest : join(root, file);
    if (!contained(root, actual)) {
      errors.push(`${file}: escaping path ${target}`);
      return;
    }
    try {
      if (!contained(canonicalRoot, await realpath(actual))) throw new Error('escaping symlink');
      await stat(actual);
      if (fragment && !anchors(await readFile(actual, 'utf8')).has(fragment))
        throw new Error('missing anchor');
    } catch (e) {
      errors.push(`${file}: broken resource ${target} (${e.code ?? e.message})`);
    }
  }

  for (const file of paths) {
    if (file !== 'SKILL.md' && file.endsWith('/SKILL.md')) errors.push(`Nested Skill: ${file}`);
    if (!['.md', '.mjs', '.js'].includes(extname(file))) continue;
    const text = await readFile(join(root, file), 'utf8');
    if (/<!-- (?:contract|generated):|\.md\.in\b|(?:\.\.\/)+_shared\//.test(text))
      errors.push(`${file}: unresolved source dependency`);
    if (file.endsWith('.md')) {
      const tree = fromMarkdown(text);
      const definitions = new Map();
      const targets = [];
      walk(tree, (node) => {
        if (node.type === 'definition') definitions.set(node.identifier, node.url);
      });
      walk(tree, (node) => {
        if (['link', 'image'].includes(node.type)) targets.push(node.url);
        if (['linkReference', 'imageReference'].includes(node.type)) {
          const url = definitions.get(node.identifier);
          if (url) targets.push(url);
          else errors.push(`${file}: missing link definition ${node.identifier}`);
        }
        // Resource paths in examples are relative to the skill root, per the spec.
        if (['code', 'inlineCode'].includes(node.type)) {
          for (const match of node.value.matchAll(
            /\b(?:references|scripts|assets)\/[a-zA-Z0-9_./-]+/g,
          ))
            targets.push(join(relative(dirname(file), '.'), match[0]).replaceAll('\\', '/'));
          for (const match of node.value.matchAll(/(?:\.\.\/)+[a-zA-Z0-9_./-]+/g))
            targets.push(match[0]);
        }
      });
      for (const target of new Set(targets)) await checkTarget(file, target);
      if (
        /\b(?:Use|Call|Invoke) (?:the )?(?:Read|Bash|Task|Edit|Grep|Glob|Skill) (?:tool|tools)\b/.test(
          text,
        )
      )
        errors.push(`${file}: proprietary tool instruction`);
      if (/npx[^\n]*issue-flow/.test(text)) errors.push(`${file}: implicit CLI installation`);
      if (
        /\bissue-flow (?:policy|conventions|init|agent|run|execute|resume)\b/.test(text) &&
        file !== 'references/cli-integration.md'
      )
        errors.push(`${file}: CLI invocation outside optional integration`);
    } else {
      for (const match of text.matchAll(
        /(?:from\s*|import\s*(?:\(\s*)?|require\s*\()\s*['"]([^'"]+)['"]/g,
      )) {
        const target = match[1];
        if (target.startsWith('node:')) continue;
        if (!target.startsWith('.')) errors.push(`${file}: non-bundled dependency ${target}`);
        else await checkTarget(file, target);
      }
    }
  }
  return errors;
}

export async function check() {
  const expected = await assemble();
  const errors = (await compare(expected)).map(
    (path) => `Stale artifact: ${path}; run skills:sync`,
  );
  const names = [
    ...new Set(
      [...expected.keys()].filter((p) => p.startsWith('skills/')).map((p) => p.split('/')[1]),
    ),
  ];
  for (const name of names)
    errors.push(...(await validateSkill(join(artifactRoot, name))).map((e) => `${name}: ${e}`));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`${names.length} self-contained Skills; artifacts match sources.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await check();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
