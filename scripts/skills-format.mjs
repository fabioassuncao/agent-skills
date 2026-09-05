/** Standard parsers shared by the build and the repository-specific checks. */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/issue-flow/package.json', import.meta.url));
const { parseDocument } = require('yaml');
const { marked } = require('marked');
const { default: GithubSlugger } = require('github-slugger');

export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('missing or unclosed YAML frontmatter');
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map((e) => e.message).join('; '));
  const fields = document.toJS({ maxAliasCount: 0 });
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('frontmatter must be a mapping');
  }
  return { fields, body: content.slice(match[0].length) };
}

/** Markdown links are document-relative; inline resource paths are skill-root-relative. */
export function markdownResources(content) {
  const links = [];
  const anchors = new Set();
  const slugger = new GithubSlugger();
  marked.walkTokens(marked.lexer(content), (token) => {
    if (token.type === 'link' || token.type === 'image') {
      if (!/^(?:https?:|mailto:|\/\/)/i.test(token.href)) {
        links.push({ target: token.href, rootRelative: false });
      }
    }
    if (
      token.type === 'codespan' &&
      /^(?:(?:\.\/)?(?:references|scripts|assets)\/|\.\.\/)\S+$/.test(token.text)
    ) {
      links.push({ target: token.text, rootRelative: true });
    }
    if (token.type === 'heading') {
      const text = marked.Parser.parseInline(token.tokens)
        .replace(/<[^>]*>/g, '')
        .trim();
      anchors.add(slugger.slug(text));
    }
    if (token.type === 'html') {
      for (const match of token.text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g))
        anchors.add(match[1]);
    }
  });
  return { links, anchors };
}
