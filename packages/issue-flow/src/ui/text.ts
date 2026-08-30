/**
 * Strip the markdown markers that leak into a terminal that cannot render them.
 *
 * Used by the clean view and by failure excerpts. Verbose mode keeps the
 * original text — this is only for the default surface.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Last non-empty lines of a failure report, already stripped of markdown. */
export function failureExcerpt(output: string, limit = 8): string[] {
  return output
    .split('\n')
    .map((line) => stripMarkdown(line))
    .filter((line) => line.length > 0)
    .slice(-limit);
}
