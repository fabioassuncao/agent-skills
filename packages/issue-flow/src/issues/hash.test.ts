import { describe, expect, it } from 'vitest';
import { hashIssueContent } from './hash.js';

describe('hashIssueContent', () => {
  it('returns a sha256:<hex> string', () => {
    const hash = hashIssueContent('Title', 'Body');
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const a = hashIssueContent('Add providers', 'Body with\nmultiple lines');
    const b = hashIssueContent('Add providers', 'Body with\nmultiple lines');
    expect(a).toBe(b);
  });

  it('normalizes CRLF to LF', () => {
    const crlf = hashIssueContent('Title', 'line one\r\nline two\r\n\r\nline three');
    const lf = hashIssueContent('Title', 'line one\nline two\n\nline three');
    expect(crlf).toBe(lf);
  });

  it('normalizes a lone CR to LF', () => {
    expect(hashIssueContent('Title', 'a\rb')).toBe(hashIssueContent('Title', 'a\nb'));
  });

  it('ignores surrounding whitespace on both fields', () => {
    const padded = hashIssueContent('  Title  ', '\n\n  Body  \n\n');
    expect(padded).toBe(hashIssueContent('Title', 'Body'));
  });

  it('changes when the title changes', () => {
    expect(hashIssueContent('Title A', 'Body')).not.toBe(hashIssueContent('Title B', 'Body'));
  });

  it('changes when the body changes', () => {
    expect(hashIssueContent('Title', 'Body A')).not.toBe(hashIssueContent('Title', 'Body B'));
  });

  it('distinguishes text moved from the title into the body', () => {
    expect(hashIssueContent('Title Body', '')).not.toBe(hashIssueContent('Title', 'Body'));
  });

  it('handles empty title and body', () => {
    expect(hashIssueContent('', '')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable for a known input across platforms', () => {
    // Pinned digest: a change here means the hashing contract changed and every
    // stored contentHash in issues/*/metadata.json would be invalidated.
    expect(hashIssueContent('Hello', 'World')).toBe(
      'sha256:ea4dd410bd4d7921402b4ca8762495be511a49253dd8367dfad062dc732746ab',
    );
  });
});
