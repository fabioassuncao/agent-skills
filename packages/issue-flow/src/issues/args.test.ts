import { describe, expect, it } from 'vitest';
import { IssueArgumentError, parseIssueArguments } from './args.js';

describe('parseIssueArguments', () => {
  it('accepts a single issue, the previous form', () => {
    expect(parseIssueArguments(['42'])).toEqual(['42']);
    expect(parseIssueArguments(['#42'])).toEqual(['42']);
  });

  it('reads the comma and the space forms identically', () => {
    expect(parseIssueArguments(['42,43,50'])).toEqual(['42', '43', '50']);
    expect(parseIssueArguments(['42', '43', '50'])).toEqual(['42', '43', '50']);
    expect(parseIssueArguments(['42,43', '50'])).toEqual(['42', '43', '50']);
  });

  it('tolerates spaces around the separators and a leading #', () => {
    expect(parseIssueArguments([' #42 , 43 '])).toEqual(['42', '43']);
  });

  it('accepts non-numeric identifiers, like the local provider', () => {
    expect(parseIssueArguments(['auth-refactor'])).toEqual(['auth-refactor']);
  });

  it('drops duplicates preserving the first position', () => {
    expect(parseIssueArguments(['42', '43', '42'])).toEqual(['42', '43']);
  });

  it('rejects an empty entry in a list', () => {
    expect(() => parseIssueArguments(['42,,43'])).toThrow(IssueArgumentError);
    expect(() => parseIssueArguments(['42,'])).toThrow(/empty entry/);
  });

  it('rejects an identifier that could escape the storage tree', () => {
    expect(() => parseIssueArguments(['../etc'])).toThrow(/Invalid issue identifier/);
    expect(() => parseIssueArguments(['..'])).toThrow(/Invalid issue identifier/);
  });

  it('rejects an empty list', () => {
    expect(() => parseIssueArguments([])).toThrow(/No issue was informed/);
    expect(() => parseIssueArguments([' '])).toThrow(/No issue was informed/);
  });
});
