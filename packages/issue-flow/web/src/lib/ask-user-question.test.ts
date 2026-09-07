import { describe, expect, it } from 'vitest';
import { formatAskUserQuestionAnswer, parseAskUserQuestion } from './ask-user-question';

/** PORT of `frontend/src/lib/ask-user-question.test.ts` @ d8c9d5f — 8 cases. */

describe('parseAskUserQuestion', () => {
  it('parses a valid single-question payload', () => {
    const text = JSON.stringify({
      questions: [
        {
          question: 'Você prefere gatos ou cachorros?',
          header: 'Tipo de bicho',
          multiSelect: false,
          options: [
            { label: 'Gatos', description: 'Independentes.' },
            { label: 'Cachorros', description: 'Leais.' },
          ],
        },
      ],
    });

    const parsed = parseAskUserQuestion(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0]?.header).toBe('Tipo de bicho');
    expect(parsed?.questions[0]?.multiSelect).toBe(false);
    expect(parsed?.questions[0]?.options.map((option) => option.label)).toEqual([
      'Gatos',
      'Cachorros',
    ]);
  });

  it('returns null for malformed JSON', () => {
    expect(parseAskUserQuestion('{not json')).toBeNull();
  });

  it('returns null when questions is missing', () => {
    expect(parseAskUserQuestion(JSON.stringify({ foo: 1 }))).toBeNull();
  });

  it('returns null when a question has no options', () => {
    const text = JSON.stringify({ questions: [{ question: 'q', header: 'h', options: [] }] });
    expect(parseAskUserQuestion(text)).toBeNull();
  });

  it('returns null when an option is missing a label', () => {
    const text = JSON.stringify({
      questions: [{ question: 'q', header: 'h', options: [{ description: 'x' }] }],
    });
    expect(parseAskUserQuestion(text)).toBeNull();
  });
});

describe('formatAskUserQuestionAnswer', () => {
  it('formats a single answer as one line', () => {
    expect(formatAskUserQuestionAnswer([{ header: 'Tipo de bicho', values: ['Gatos'] }])).toBe(
      'Tipo de bicho: Gatos',
    );
  });

  it('joins multiple values and questions', () => {
    expect(
      formatAskUserQuestionAnswer([
        { header: 'Tipo de bicho', values: ['Gatos', 'Cachorros'] },
        { header: 'Porte', values: ['Grande'] },
      ]),
    ).toBe('Tipo de bicho: Gatos, Cachorros\nPorte: Grande');
  });

  it('drops questions with no values', () => {
    expect(
      formatAskUserQuestionAnswer([
        { header: 'Tipo de bicho', values: ['Gatos'] },
        { header: 'Porte', values: [] },
      ]),
    ).toBe('Tipo de bicho: Gatos');
  });
});
