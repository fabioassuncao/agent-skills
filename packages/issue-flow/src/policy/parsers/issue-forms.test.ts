import { describe, expect, it } from 'vitest';
import { extractFrontMatter, parseTemplateMetadata } from './issue-forms.js';

describe('parseTemplateMetadata', () => {
  it('reads the metadata of an Issue Form, including the flow label list', () => {
    const source = [
      'name: Bug Report',
      'description: File a bug report',
      'title: "[Bug]: "',
      'labels: ["bug", "triage"]',
      'type: Bug',
      'assignees:',
      '  - octocat',
      'body:',
      '  - type: markdown',
      '    attributes:',
      '      value: Thanks for taking the time!',
      '  - type: input',
      '    id: version',
      '    attributes:',
      '      label: Version',
    ].join('\n');

    expect(parseTemplateMetadata(source)).toEqual({
      name: 'Bug Report',
      about: 'File a bug report',
      title: '[Bug]: ',
      labels: ['bug', 'triage'],
      type: 'Bug',
      assignees: ['octocat'],
    });
  });

  it('never mistakes a nested `type:` inside body for the Issue Type', () => {
    const source = ['name: Feature', 'body:', '  - type: markdown', '  - type: textarea'].join(
      '\n',
    );

    expect(parseTemplateMetadata(source).type).toBeNull();
  });

  it('reads a block sequence of labels', () => {
    const source = ['name: Task', 'labels:', '  - chore', "  - 'needs triage'", 'body: []'].join(
      '\n',
    );

    expect(parseTemplateMetadata(source).labels).toEqual(['chore', 'needs triage']);
  });

  it('accepts a bare scalar where GitHub allows a single label', () => {
    expect(parseTemplateMetadata('labels: bug').labels).toEqual(['bug']);
  });

  it('drops mapping entries from a sequence instead of inventing a label', () => {
    const source = ['labels:', '  - name: bug', '  - color: red'].join('\n');

    expect(parseTemplateMetadata(source).labels).toEqual([]);
  });

  it('falls back from `description` to `about` for legacy templates', () => {
    expect(parseTemplateMetadata('about: Report a bug').about).toBe('Report a bug');
  });

  it('strips inline comments outside quotes and keeps the ones inside', () => {
    expect(parseTemplateMetadata('name: Bug # the classic').name).toBe('Bug');
    expect(parseTemplateMetadata('title: "[Bug #1]: "').title).toBe('[Bug #1]: ');
  });

  it('returns empty metadata for a document that is not YAML at all', () => {
    expect(parseTemplateMetadata('Just some prose.\n\nWith a paragraph.')).toEqual({
      name: null,
      about: null,
      title: null,
      labels: [],
      type: null,
      assignees: [],
    });
  });

  it('keeps the first occurrence of a duplicated key', () => {
    expect(parseTemplateMetadata('name: first\nname: second').name).toBe('first');
  });
});

describe('extractFrontMatter', () => {
  it('extracts the block of a markdown template', () => {
    const source = ['---', 'name: Bug report', 'labels: bug', '---', '', '## Steps'].join('\n');

    expect(extractFrontMatter(source)).toBe('name: Bug report\nlabels: bug\n');
  });

  it('returns null for a template with no front matter', () => {
    expect(extractFrontMatter('## Steps\n\nDescribe the bug.')).toBeNull();
  });

  it('returns null for an unterminated block rather than swallowing the body', () => {
    expect(extractFrontMatter('---\nname: Bug report\n')).toBeNull();
  });
});
