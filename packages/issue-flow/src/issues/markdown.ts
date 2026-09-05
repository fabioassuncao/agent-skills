/**
 * Title lives in the leading H1, body is everything after it.
 *
 * Only the first non-empty line is considered: an H1 further down belongs to
 * the body (issue descriptions routinely use headings), so promoting it would
 * silently retitle the Issue.
 */
export function parseIssueMarkdown(content: string): { title: string; body: string } {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => line.trim().length > 0);
  const heading = headingIndex === -1 ? undefined : lines[headingIndex].match(/^#[ \t]+(.*)$/);

  if (!heading) {
    return { title: '', body: lines.join('\n').trim() };
  }

  return {
    title: heading[1].trim(),
    body: lines
      .slice(headingIndex + 1)
      .join('\n')
      .trim(),
  };
}
