/**
 * PORT of `frontend/src/lib/promptUtils.ts` @ d8c9d5f (15 lines).
 *
 * Text taken off a terminal and handed to an agent as a prompt. Three
 * treatments, each for a failure that is invisible until it happens:
 *
 * - **ANSI stripped** — escape sequences in a prompt are read by the agent as
 *   content, and by the receiving terminal as commands.
 * - **Non-printables dropped** — anything outside tab, newline and printable
 *   ASCII can re-enter control state on the way through.
 * - **Truncated from the front, not the back** — CI logs put the failure at the
 *   end, so the tail is the part worth keeping.
 */

function stripAnsi(input: string): string {
  // biome-ignore-start lint/suspicious/noControlCharactersInRegex: matching the escape character is the whole job of an ANSI stripper.
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B[@-_]/g, '');
  // biome-ignore-end lint/suspicious/noControlCharactersInRegex: see above.
}

export function normalizeTextForPrompt(input: string, maxChars = 30000): string {
  const noAnsi = stripAnsi(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Keep tabs, newlines, and printable ASCII only to avoid terminal control issues.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: tab and newline are named by code point precisely so everything else is dropped.
  const cleaned = noAnsi.replace(/[^\x09\x0A\x20-\x7E]/g, '');
  if (cleaned.length > maxChars) {
    return `[... truncado]\n${cleaned.slice(-maxChars)}`;
  }
  return cleaned;
}
