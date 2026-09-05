#!/usr/bin/env node
/**
 * Structural validation of every Agent Skill in `skills/`.
 *
 * Pins the parts of https://agentskills.io/specification that a reviewer cannot
 * hold in their head, plus the one rule the spec states and no tool enforces:
 * **a skill may not reference anything outside its own directory**.
 *
 * That rule is not pedantry. Every real client — `npx skills`, Cursor, Codex,
 * OpenCode, Gemini CLI, Antigravity, the Microsoft Agent Framework — installs or
 * scans the directory that holds the SKILL.md and nothing above it. A `../`
 * reference is a link that resolves in the repository and dangles everywhere the
 * skill is actually used, which is the worst kind of defect: invisible to the
 * author, invisible to CI, visible only to the user.
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
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const treeIndex = process.argv.indexOf('--tree');
/** The assembled tree to check, or null for the repository's own sources. */
const TREE = treeIndex === -1 ? null : process.argv[treeIndex + 1];

if (treeIndex !== -1 && !TREE) {
  console.error('Usage: validate-skills.mjs [--tree <dir>]');
  process.exit(2);
}

const SKILLS =
  TREE === null ? join(ROOT, 'skills') : isAbsolute(TREE) ? TREE : resolve(ROOT, TREE);

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

/**
 * Minimal YAML frontmatter reader.
 *
 * Deliberately not a YAML library: the spec's frontmatter is a flat map of
 * scalars plus one nested string map, adding a dependency to parse that would
 * be its own kind of overengineering. Anything this cannot parse is reported
 * rather than guessed at.
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return { error: 'missing YAML frontmatter' };

  const end = content.indexOf('\n---', 3);
  if (end === -1) return { error: 'frontmatter is never closed' };

  const raw = content.slice(4, end + 1);
  const body = content.slice(content.indexOf('\n', end + 1) + 1);
  const fields = {};

  let key = null;
  let folded = null;
  let nested = null;

  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      if (folded !== null) folded.push('');
      continue;
    }

    const indented = /^\s/.test(line);

    if (indented && nested !== null) {
      const pair = line.trim().match(/^([\w.-]+):\s*(.*)$/);
      if (pair === null) return { error: `cannot parse metadata line: ${line.trim()}` };
      nested[pair[1]] = pair[2].replace(/^["']|["']$/g, '');
      continue;
    }

    if (indented && folded !== null) {
      folded.push(line.trim());
      continue;
    }

    const match = line.match(/^([\w.-]+):\s*(.*)$/);
    if (match === null) return { error: `cannot parse frontmatter line: ${line}` };

    if (folded !== null && key !== null) fields[key] = folded.join(' ').trim();
    folded = null;
    nested = null;

    key = match[1];
    const value = match[2].trim();

    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      folded = [];
    } else if (value === '') {
      nested = {};
      fields[key] = nested;
    } else {
      fields[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  if (folded !== null && key !== null) fields[key] = folded.join(' ').trim();

  return { fields, body };
}

/** Every local link and inline path a SKILL.md points at. */
function localReferences(content) {
  const found = new Set();

  for (const [, target] of content.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
    found.add(target.split('#')[0]);
  }
  // `references/foo.md` and `scripts/foo.sh` written as inline code.
  for (const [, target] of content.matchAll(/`((?:\.\.\/|\.\/)?(?:references|scripts|assets)\/[^`\s]+)`/g)) {
    found.add(target);
  }

  return [...found].filter((t) => t !== '');
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

  const parsed = parseFrontmatter(content);
  if (parsed.error !== undefined) {
    error(name, parsed.error);
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

  if (typeof fields.description !== 'string' || fields.description === '') {
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

  // --- optional fields -----------------------------------------------------
  if (fields.compatibility !== undefined) {
    if (typeof fields.compatibility !== 'string') {
      error(name, '`compatibility` must be a string');
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
    if (typeof fields.metadata !== 'object' || fields.metadata === null) {
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

  // --- portability: nothing may point outside the skill --------------------
  for (const target of localReferences(content)) {
    const resolved = normalize(join(dir, target));
    const outside = relative(dir, resolved).startsWith('..');

    if (outside) {
      error(
        name,
        `\`${target}\` points outside the skill directory — it will dangle wherever the skill is installed`,
      );
      continue;
    }

    try {
      await stat(resolved);
    } catch {
      if (!suppliedByBuild(target)) {
        error(name, `\`${target}\` does not exist`);
      }
    }
  }

  // --- a shipped file nothing points at is dead weight -------------------
  //
  // A dead reference is not a broken one, so nothing used to catch it: four
  // generated files sat in the tree that no SKILL.md cited. They cost the
  // reader nothing at runtime and the maintainer every time they are edited.
  try {
    const refs = await readdir(join(dir, 'references'), { withFileTypes: true });
    const cited = new Set(localReferences(content));
    for (const entry of refs) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (cited.has(`references/${entry.name}`)) continue;
      error(name, `references/${entry.name} is never cited by SKILL.md — remove it`);
    }
  } catch {
    /* no references/ */
  }

  // --- a reference may not be reachable only through another reference ----
  //
  // "Keep file references one level deep from SKILL.md. Avoid deeply nested
  // reference chains." An agent that only meets a file by following a link
  // inside another file may never open it — and if that file was never shipped,
  // the link is simply broken, which is how the three-skill defect got through
  // the first version of this check.
  const named = new Set(localReferences(content));
  try {
    const refs = await readdir(join(dir, 'references'), { withFileTypes: true });
    for (const entry of refs) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const body = await readFile(join(dir, 'references', entry.name), 'utf-8');

      for (const target of localReferences(body)) {
        const resolved = normalize(join(dir, target));
        if (relative(dir, resolved).startsWith('..')) {
          error(name, `references/${entry.name}: \`${target}\` points outside the skill`);
          continue;
        }
        try {
          await stat(resolved);
        } catch {
          if (!suppliedByBuild(target)) {
            error(name, `references/${entry.name}: \`${target}\` does not exist`);
          }
          continue;
        }
        if (!named.has(target) && target !== `references/${entry.name}`) {
          error(
            name,
            `references/${entry.name} points at \`${target}\`, which SKILL.md never names — ` +
              'a reference reachable only through another reference is a chain',
          );
        }
      }
    }
  } catch {
    /* no references/ */
  }

  // --- the README ships with the skill, so its links must resolve too -----
  try {
    const readme = await readFile(join(dir, 'README.md'), 'utf-8');
    for (const target of localReferences(readme)) {
      const resolved = normalize(join(dir, target));
      if (relative(dir, resolved).startsWith('..')) {
        error(name, `README.md: \`${target}\` points outside the skill directory`);
        continue;
      }
      try {
        await stat(resolved);
      } catch {
        if (!suppliedByBuild(target)) {
          error(name, `README.md: \`${target}\` does not exist`);
        }
      }
    }
  } catch {
    warn(name, 'no README.md: humans browsing the repository have nothing to read');
  }

  // --- scripts must be runnable -------------------------------------------
  try {
    const scripts = await readdir(join(dir, 'scripts'), { withFileTypes: true });
    for (const entry of scripts) {
      if (!entry.isFile()) continue;
      const info = await stat(join(dir, 'scripts', entry.name));
      // 0o111 — executable by someone. A script nobody can run is a broken step.
      if ((info.mode & 0o111) === 0) {
        error(name, `scripts/${entry.name} is not executable`);
      }
    }
  } catch {
    /* no scripts/ — the common case */
  }

  // --- self-documentation --------------------------------------------------
  if (!/##\s+Requirements/i.test(content)) {
    warn(name, 'no "Requirements" section: say what it needs and what it writes');
  }
}

async function main() {
  const entries = await readdir(SKILLS, { withFileTypes: true });
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

  console.log(`✓ ${skills.length} skills conform to the Agent Skills specification`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
