import { describe, expect, it } from 'vitest';
import { parseDocumentResult } from './document-result.js';

describe('parseDocumentResult', () => {
  it('extracts a final document and normalizes its newline', () => {
    expect(parseDocumentResult('context\n<prd>\n# PRD\n\nUseful body\n</prd>\n', 'prd')).toBe(
      '# PRD\n\nUseful body\n',
    );
  });

  it('rejects missing, repeated, trailing or empty blocks', () => {
    expect(() => parseDocumentResult('plain text', 'prd')).toThrow('exactly one');
    expect(() => parseDocumentResult('<prd>long enough</prd><prd>again long</prd>', 'prd')).toThrow(
      'exactly one',
    );
    expect(() => parseDocumentResult('<prd>long enough</prd> trailing', 'prd')).toThrow(
      'exactly one',
    );
    expect(() => parseDocumentResult('<prd>x</prd>', 'prd')).toThrow('too short');
  });
});
