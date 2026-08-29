/**
 * A deliberately small YAML reader for Issue Form and Issue Template metadata.
 *
 * Issue Flow does not need a YAML engine: it needs six top-level keys (`name`,
 * `description`/`about`, `title`, `labels`, `type`, `assignees`) out of a file
 * whose remaining structure — the `body:` array of form elements — it has no
 * use for. Pulling a parser dependency in to read those six keys would trade a
 * supply-chain surface for nothing.
 *
 * The reader therefore works on top-level keys only: it locates every line that
 * starts a key at indentation zero, and parses the region of the ones it cares
 * about. Anything nested (a `body:` element, its `attributes:`) is skipped
 * whole, which is why `- type: markdown` inside `body:` can never be mistaken
 * for the top-level `type:` of an Issue Type.
 */

/** The metadata block shared by Issue Forms (`.yml`) and templates (`.md`). */
export interface TemplateMetadata {
  name: string | null;
  about: string | null;
  title: string | null;
  labels: string[];
  type: string | null;
  assignees: string[];
}

export function emptyTemplateMetadata(): TemplateMetadata {
  return { name: null, about: null, title: null, labels: [], type: null, assignees: [] };
}

const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/;

interface KeyRegion {
  key: string;
  /** Text on the key's own line, after the colon. Empty when the value is a block. */
  inline: string;
  /** Lines below the key, up to the next top-level key. */
  block: string[];
}

/**
 * Split a YAML document into its top-level key regions.
 *
 * Exported for the templates parser, which reads the same regions out of a
 * markdown front matter block.
 */
export function topLevelRegions(source: string): Map<string, KeyRegion> {
  const regions = new Map<string, KeyRegion>();
  const lines = source.split(/\r?\n/);

  let current: KeyRegion | null = null;
  for (const line of lines) {
    // A line that begins with whitespace, a dash or a comment can never open a
    // top-level key, so it always belongs to the region already open.
    const match = /^[^\s#-]/.test(line) ? TOP_LEVEL_KEY.exec(line) : null;
    if (match?.[1] !== undefined) {
      current = { key: match[1], inline: (match[2] ?? '').trim(), block: [] };
      // First occurrence wins, matching how a YAML loader would report a
      // duplicate key as a document error rather than silently taking the last.
      if (!regions.has(current.key)) {
        regions.set(current.key, current);
      }
      continue;
    }
    current?.block.push(line);
  }

  return regions;
}

/** Strip a trailing `# comment` that is not inside quotes. */
function stripComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(value[i - 1] ?? ''))) {
      return value.slice(0, i);
    }
  }
  return value;
}

/** Unquote a scalar, handling the two YAML quoting styles. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === '"' && last === '"') {
      return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    if (first === "'" && last === "'") {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }
  }
  return trimmed;
}

/** Split a flow sequence body (`a, "b, c", d`) on its top-level commas. */
function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let buffer = '';
  let quote: string | null = null;

  for (const char of inner) {
    if (quote !== null) {
      if (char === quote) quote = null;
      buffer += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
      continue;
    }
    if (char === ',') {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += char;
  }
  parts.push(buffer);

  return parts.map(unquote).filter((part) => part !== '');
}

/** Read a region as a scalar, returning null when it holds no usable value. */
function readScalar(region: KeyRegion | undefined): string | null {
  if (region === undefined) return null;

  const inline = stripComment(region.inline).trim();
  if (inline !== '' && inline !== '|' && inline !== '>' && inline !== '|-' && inline !== '>-') {
    const value = unquote(inline);
    return value === '' ? null : value;
  }

  // Block scalar (`|`, `>`) or a value that simply starts on the next line.
  const collected = region.block
    .filter((line) => line.trim() !== '')
    .map((line) => line.trim())
    .join(inline.startsWith('>') ? ' ' : '\n')
    .trim();
  return collected === '' ? null : collected;
}

/** Read a region as a sequence, accepting both the flow and the block style. */
function readSequence(region: KeyRegion | undefined): string[] {
  if (region === undefined) return [];

  const inline = stripComment(region.inline).trim();
  if (inline.startsWith('[')) {
    const closing = inline.lastIndexOf(']');
    return splitFlow(inline.slice(1, closing === -1 ? undefined : closing));
  }
  if (inline !== '') {
    // A bare scalar where a list was expected — GitHub accepts `labels: bug`.
    const single = unquote(inline);
    return single === '' ? [] : [single];
  }

  const items: string[] = [];
  for (const line of region.block) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (!trimmed.startsWith('- ') && trimmed !== '-') break;
    const value = unquote(stripComment(trimmed.slice(1)).trim());
    // `- key: value` is a mapping, not a label — a list of those is not a
    // taxonomy and taking its first line would invent one.
    if (value === '' || /^[A-Za-z_][A-Za-z0-9_-]*:\s/.test(value)) continue;
    items.push(value);
  }
  return items;
}

/**
 * Read the metadata of an Issue Form or Issue Template body.
 *
 * Never throws: a file that is not YAML at all yields empty metadata, which is
 * the same thing the caller does with a template it cannot understand.
 */
export function parseTemplateMetadata(source: string): TemplateMetadata {
  const regions = topLevelRegions(source);

  return {
    name: readScalar(regions.get('name')),
    // Issue Forms spell it `description`, legacy markdown templates `about`.
    about: readScalar(regions.get('about')) ?? readScalar(regions.get('description')),
    title: readScalar(regions.get('title')),
    labels: readSequence(regions.get('labels')),
    type: readScalar(regions.get('type')),
    assignees: readSequence(regions.get('assignees')),
  };
}

/**
 * Extract the YAML front matter of a markdown template.
 *
 * Returns null when the file does not open with a `---` fence, which is the
 * common case for a plain `.md` template with no metadata at all.
 */
export function extractFrontMatter(source: string): string | null {
  const normalized = source.replace(/^\uFEFF/, '');
  if (!/^---[ \t]*\r?\n/.test(normalized)) return null;

  const rest = normalized.slice(normalized.indexOf('\n') + 1);
  const closing = /^---[ \t]*$/m.exec(rest);
  if (closing?.index === undefined) return null;

  return rest.slice(0, closing.index);
}
