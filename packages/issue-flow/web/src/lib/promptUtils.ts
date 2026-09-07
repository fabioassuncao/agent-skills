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
