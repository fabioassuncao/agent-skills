#!/usr/bin/env node
/**
 * Structural validation of every Agent Skill in `skills/`.
 *
 * Checks https://agentskills.io/specification plus the Issue Flow packaging
 * contract (which is stricter than the open format in several respects):
 * **a skill may not reference anything outside its own directory**.
 *
 * An individual installation contains the Skill directory, not its siblings.
 * A sibling reference can resolve in the repository but dangle after copying,
 * so checking the source tree alone is insufficient.
 *
 * Two modes, because the working tree and the published tree are not the same
 * thing:
 *
 *   validate-skills.mjs                  # source mode, over skills/
 *   validate-skills.mjs --tree <dir>     # strict, over an assembled tree
 *
 * In **source mode** a cited reference may be absent from the skill, but only
 * when `skills/_shared/contracts/` holds it — that is a contract
 * `build-skills-tree.mjs` will materialise. Absent from both is still an error.
 *
 * In **tree mode** nothing may be missing: what is checked is the artifact a
 * user installs, so a reference that is not there is a dangling link in the
 * field.
 *
 * Exits 0 when clean, 1 when any error was found. Warnings never fail.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { markdownResources, parseFrontmatter } from './skills-format.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const treeIndex = process.argv.indexOf('--tree');
/** The assembled tree to check, or null for the repository's own sources. */
const TREE = treeIndex === -1 ? null : process.argv[treeIndex + 1];

if (treeIndex !== -1 && !TREE) {
  console.error('Usage: validate-skills.mjs [--tree <dir>]');
  process.exit(2);
}

const SKILLS = TREE === null ? join(ROOT, 'skills') : isAbsolute(TREE) ? TREE : resolve(ROOT, TREE);

/**
 * Contracts that live in `skills/_shared/contracts/` and are materialised into
 * each citing skill at build time. Empty in tree mode: there, everything a
 * skill cites must already be present.
 */
const SHARED = new Set();
if (TREE === null) {
  const { readdirSync } = await import('node:fs');
  try {
    for (const entry of readdirSync(join(ROOT, 'skills/_shared/contracts'), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith('.md')) SHARED.add(entry.name);
    }
  } catch {
    /* no shared contracts at all is legitimate */
  }
}

/** Whether a missing reference is one the build will supply. */
function suppliedByBuild(target) {
  const match = target.match(/^references\/([a-z0-9-]+\.md)$/);
  return match !== null && SHARED.has(match[1]);
}

/** Frontmatter keys the open specification defines. Anything else is vendor. */
const SPEC_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

/**
 * `allowed-tools` is documented as experimental and its support varies between
 * implementations. A canonical skill must not need it, so using it is an error
 * here rather than a warning.
 */
const EXPERIMENTAL_FIELDS = new Set(['allowed-tools']);

const LIMITS = {
  name: 64,
  description: 1024,
  compatibility: 500,
  lines: 500,
  /** The spec recommends < 5000 tokens for the body. ~1.35 tokens per word. */
  tokens: 5000,
};

const problems = [];
const warnings = [];

function error(skill, message) {
  problems.push(`${skill}: ${message}`);
}
function warn(skill, message) {
  warnings.push(`${skill}: ${message}`);
}

/** Paths used by both inline resource citations and Markdown links. */
function localReferences(content) {
  return [
    ...new Set(
      markdownResources(content)
        .links.map(({ target }) => target.split('#')[0])
        .filter(Boolean),
    ),
  ];
}

/** Rough token estimate. Good enough to catch a body that doubled in size. */
function estimateTokens(text) {
  return Math.round(text.split(/\s+/).filter(Boolean).length * 1.35);
}

async function validateSkill(name) {
  const dir = join(SKILLS, name);
  const skillFile = join(dir, 'SKILL.md');

  let content;
  try {
    content = await readFile(skillFile, 'utf-8');
  } catch {
    error(name, 'no SKILL.md');
    return;
  }

  let parsed;
  try {
    parsed = parseFrontmatter(content);
  } catch (err) {
    error(name, err.message);
    return;
  }

  const { fields, body } = parsed;

  // --- required fields -----------------------------------------------------
  if (typeof fields.name !== 'string' || fields.name === '') {
    error(name, '`name` is required and must be a non-empty string');
  } else {
    if (fields.name.length > LIMITS.name) {
      error(name, `\`name\` is ${fields.name.length} characters (max ${LIMITS.name})`);
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fields.name)) {
      error(
        name,
        `\`name\` must be lowercase alphanumerics separated by single hyphens, got "${fields.name}"`,
      );
    }
    if (fields.name !== name) {
      error(name, `\`name\` is "${fields.name}" but the directory is "${name}"`);
    }
    // Claude rejects a name carrying its own vendor words. Harmless everywhere
    // else, fatal there, and free to avoid.
    if (/anthropic|claude/i.test(fields.name)) {
      error(name, '`name` must not contain the reserved words "anthropic" or "claude"');
    }
  }

  if (typeof fields.description !== 'string' || fields.description.trim() === '') {
    error(name, '`description` is required and must be a non-empty string');
  } else if (fields.description.length > LIMITS.description) {
    error(
      name,
      `\`description\` is ${fields.description.length} characters (max ${LIMITS.description})`,
    );
  }

  // `name` and `description` are injected into a system prompt, and some
  // implementations reject anything that parses as a tag. A `<N>` placeholder
  // reads as one, so write it `{N}`.
  for (const field of ['name', 'description']) {
    const value = fields[field];
    if (typeof value === 'string' && /<[a-zA-Z/][^>]*>/.test(value)) {
      error(name, `\`${field}\` must not contain anything that parses as an XML tag`);
    }
  }

  if (fields.license !== undefined && typeof fields.license !== 'string')
    error(name, '`license` must be a string');

  // --- optional fields -----------------------------------------------------
  if (fields.compatibility !== undefined) {
    if (typeof fields.compatibility !== 'string' || fields.compatibility.trim() === '') {
      error(name, '`compatibility` must be a non-empty string');
    } else if (fields.compatibility.length > LIMITS.compatibility) {
      error(
        name,
        `\`compatibility\` is ${fields.compatibility.length} characters (max ${LIMITS.compatibility})`,
      );
    }
  } else {
    warn(name, 'no `compatibility`: state the binaries and access this skill needs');
  }

  if (fields.metadata !== undefined) {
    if (
      typeof fields.metadata !== 'object' ||
      fields.metadata === null ||
      Array.isArray(fields.metadata)
    ) {
      error(name, '`metadata` must be a map of string keys to string values');
    } else {
      for (const [k, v] of Object.entries(fields.metadata)) {
        if (typeof v !== 'string') error(name, `metadata.${k} must be a string`);
      }
    }
  }

  for (const field of Object.keys(fields)) {
    if (EXPERIMENTAL_FIELDS.has(field)) {
      error(
        name,
        `\`${field}\` is experimental and support varies between agents — a canonical skill must not require it`,
      );
    } else if (!SPEC_FIELDS.has(field)) {
      error(name, `\`${field}\` is not a field of the Agent Skills specification`);
    }
  }

  // --- size ----------------------------------------------------------------
  const lines = content.split('\n').length;
  if (lines > LIMITS.lines) {
    error(name, `SKILL.md is ${lines} lines (max ${LIMITS.lines}) — move detail into references/`);
  }
  const tokens = estimateTokens(body);
  if (tokens > LIMITS.tokens) {
    error(name, `SKILL.md body is ~${tokens} tokens (max ${LIMITS.tokens})`);
  }

  // Validate every shipped file, including nested references and generated contracts.
  const files = new Map();
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const rel = relative(dir, path).split('\\').join('/');
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        error(name, `${rel}: symlinks are not portable`);
        continue;
      }
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) {
        error(name, `${rel}: unsupported file type`);
        continue;
      }
      files.set(
        rel,
        /\.(md|sh|py|mjs|js|json|ya?ml)$/.test(path) ? await readFile(path, 'utf8') : null,
      );
      if (
        rel.startsWith('scripts/') &&
        /\.(sh|py|mjs|js)$/.test(rel) &&
        (info.mode & 0o111) === 0
      ) {
        error(name, `${rel}: script is not executable`);
      }
      if (
        TREE === null &&
        path.endsWith('.md') &&
        files.get(rel).startsWith('<!-- Generated from ')
      ) {
        error(name, `${rel}: generated files do not belong in the source tree`);
      }
    }
  }
  await walk(dir);
  for (const target of localReferences(body)) {
    if (!files.has(target) && suppliedByBuild(target)) {
      files.set(
        target,
        await readFile(join(ROOT, 'skills/_shared/contracts', target.slice(11)), 'utf8'),
      );
    }
  }
  const named = new Set(localReferences(body));
  for (const [file, text] of files) {
    if (file.startsWith('references/') && !named.has(file)) {
      error(name, `${file}: must be cited directly by SKILL.md`);
    }
    if (text === null) continue;
    const prose = file === 'SKILL.md' ? body : text;
    const flat = prose.replace(/\s+/g, ' ');
    if (/\bnpx\b[^`\n]*\bissue-flow(?:@|\s)/.test(flat)) {
      error(
        name,
        `${file}: downloading Issue Flow at runtime is forbidden; use the portable fallback`,
      );
    }
    if (
      /~\/\.issue-flow|ISSUE_FLOW_HOME|\bissue-flow\s+(?:db|resume|web|routing|agent)\b/.test(flat)
    ) {
      error(name, `${file}: depends on private CLI runtime/state`);
    }
    if (/\b(?:Read|Write|Edit|Bash|Task|WebFetch|Skill)\s*\(/.test(flat) || /!`/.test(flat)) {
      error(name, `${file}: provider-specific tool invocation or dynamic context injection`);
    }
    if (!file.endsWith('.md')) continue;
    for (const { target, rootRelative } of markdownResources(prose).links) {
      let decoded;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        error(name, `${file}: malformed URL ${target}`);
        continue;
      }
      const [path, anchor] = decoded.split('#');
      if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
        error(name, `${file}: absolute or non-portable path ${target}`);
        continue;
      }
      const resolved = path
        ? resolve(rootRelative ? dir : dirname(join(dir, file)), path)
        : join(dir, file);
      const rel = relative(dir, resolved).split('\\').join('/');
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
        error(name, `${file}: ${target} points outside the skill`);
        continue;
      }
      if (!files.has(rel)) {
        // Directory links are useful, but may not point at an absent directory.
        try {
          if (!(await lstat(resolved)).isDirectory()) throw new Error();
        } catch {
          error(name, `${file}: ${target} does not exist`);
        }
        continue;
      }
      if (
        anchor &&
        files.get(rel) !== null &&
        !markdownResources(files.get(rel)).anchors.has(anchor)
      ) {
        error(name, `${file}: ${target} has an invalid anchor`);
      }
    }
  }

  // --- self-documentation --------------------------------------------------
  if (!/##\s+Requirements/i.test(content)) {
    warn(name, 'no "Requirements" section: say what it needs and what it writes');
  }
}

async function main() {
  const entries = await readdir(SKILLS, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) error(entry.name, 'skill directory is a symlink');
  }
  const skills = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  if (skills.length === 0) {
    console.error('No skills found under skills/');
    process.exit(1);
  }

  for (const skill of skills) await validateSkill(skill);

  // A shared contract exists to be materialised into the skills that cite it.
  // One nobody cites is a source file with no output — the same dead weight the
  // per-skill check catches, one level up.
  if (TREE === null && SHARED.size > 0) {
    const cited = new Set();
    for (const skill of skills) {
      try {
        const body = await readFile(join(SKILLS, skill, 'SKILL.md'), 'utf-8');
        for (const target of localReferences(body)) {
          const match = target.match(/^references\/([a-z0-9-]+\.md)$/);
          if (match !== null) cited.add(match[1]);
        }
      } catch {
        /* already reported */
      }
    }
    for (const contract of SHARED) {
      if (!cited.has(contract)) {
        problems.push(
          `skills/_shared/contracts/${contract}: no SKILL.md cites it — remove it, ` +
            'or move it into the one skill that needs it',
        );
      }
    }
  }

  for (const message of warnings) console.warn(`  warning  ${message}`);

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n`);
    for (const message of problems) console.error(`  error    ${message}`);
    process.exit(1);
  }

  console.log(
    `✓ ${skills.length} skills pass structural and portability checks (not behavioral certification)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
