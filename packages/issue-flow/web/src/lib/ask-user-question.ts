import type { AskUserQuestionInput, AskUserQuestionItem, AskUserQuestionOption } from './types';

/**
 * PORT of `frontend/src/lib/ask-user-question.ts` @ d8c9d5f (74 lines).
 *
 * This is human-in-the-loop already built (§48.1 marks it a priority port): the
 * agent calls an `AskUserQuestion` tool, the backend forwards its compact JSON
 * verbatim, and this turns it into something clickable.
 *
 * The parser returns `null` on **any** shape mismatch rather than salvaging
 * part of the payload — a half-parsed question renders options the agent did
 * not offer, and the caller's fallback (render it as a plain tool call) is
 * strictly better than a plausible wrong answer.
 */

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOption(value: unknown): AskUserQuestionOption | null {
  if (!isRecord(value) || typeof value.label !== 'string' || value.label.length === 0) {
    return null;
  }
  return {
    label: value.label,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  };
}

function parseQuestion(value: unknown): AskUserQuestionItem | null {
  if (!isRecord(value)) return null;
  if (typeof value.question !== 'string' || typeof value.header !== 'string') return null;
  if (!Array.isArray(value.options)) return null;

  const options: AskUserQuestionOption[] = [];
  for (const rawOption of value.options) {
    const option = parseOption(rawOption);
    if (!option) return null;
    options.push(option);
  }
  if (options.length === 0) return null;

  return {
    question: value.question,
    header: value.header,
    ...(typeof value.multiSelect === 'boolean' ? { multiSelect: value.multiSelect } : {}),
    options,
  };
}

/**
 * Parse the `toolUse.text` payload of an AskUserQuestion call into a validated
 * structure. Returns `null` on any shape mismatch so callers fall back to the
 * generic tool rendering.
 */
export function parseAskUserQuestion(text: string): AskUserQuestionInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) return null;

  const questions: AskUserQuestionItem[] = [];
  for (const rawQuestion of parsed.questions) {
    const question = parseQuestion(rawQuestion);
    if (!question) return null;
    questions.push(question);
  }
  if (questions.length === 0) return null;

  return { questions };
}

/**
 * Build the follow-up message sent back to the agent when the user answers.
 * Each answered question becomes a `${header}: ${values}` line; empty questions
 * are dropped.
 */
export function formatAskUserQuestionAnswer(
  answers: Array<{ header: string; values: string[] }>,
): string {
  return answers
    .filter((answer) => answer.values.length > 0)
    .map((answer) => `${answer.header}: ${answer.values.join(', ')}`)
    .join('\n');
}
