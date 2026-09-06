/** Extract one non-empty, final tagged document from a headless response. */
export function parseDocumentResult(output: string, tag: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) throw new Error(`Invalid document tag: ${tag}`);
  const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>\\s*$`);
  const matches = [...output.matchAll(new RegExp(`<${tag}>`, 'g'))];
  const match = output.match(pattern);
  if (matches.length !== 1 || match?.[1] === undefined) {
    throw new Error(`Expected exactly one final <${tag}> block.`);
  }
  const content = match[1].trim();
  if (content.length < 10) throw new Error(`<${tag}> content is empty or too short.`);
  return `${content}\n`;
}
