import { describe, expect, it } from 'vitest';
import { IssueDraftParseError, parseIssueDraft } from './draft.js';

function block(inner: string): string {
  return `<issue-draft>\n${inner}\n</issue-draft>`;
}

describe('parseIssueDraft', () => {
  it('reads title, labels and body', () => {
    const draft = parseIssueDraft(
      block(
        '<title>Add retries</title>\n<labels>bug, enhancement</labels>\n<body>Why\n\n- one</body>',
      ),
    );

    expect(draft).toEqual({
      title: 'Add retries',
      body: 'Why\n\n- one',
      labels: ['bug', 'enhancement'],
    });
  });

  it('ignores commentary around the block', () => {
    const draft = parseIssueDraft(
      `I looked at the codebase and found no duplicates.\n\n${block(
        '<title>T</title>\n<body>B</body>',
      )}\n\nLet me know if you want changes.`,
    );

    expect(draft.title).toBe('T');
    expect(draft.body).toBe('B');
  });

  it('keeps the last block when the agent restates the draft', () => {
    const draft = parseIssueDraft(
      `${block('<title>First</title>\n<body>Old</body>')}\n\nOn reflection:\n\n${block(
        '<title>Second</title>\n<body>New</body>',
      )}`,
    );

    expect(draft.title).toBe('Second');
    expect(draft.body).toBe('New');
  });

  it('preserves a multi-line markdown body verbatim', () => {
    const body = '## Context\n\nSomething broke.\n\n## Acceptance criteria\n\n- [ ] fixed';
    const draft = parseIssueDraft(block(`<title>T</title>\n<body>\n${body}\n</body>`));

    expect(draft.body).toBe(body);
  });

  it('normalizes CRLF line endings', () => {
    const draft = parseIssueDraft(
      '<issue-draft>\r\n<title>T</title>\r\n<body>a\r\nb</body>\r\n</issue-draft>',
    );

    expect(draft.body).toBe('a\nb');
  });

  it('defaults labels to an empty list when the tag is absent', () => {
    expect(parseIssueDraft(block('<title>T</title>\n<body>B</body>')).labels).toEqual([]);
  });

  it('drops empty entries and the "(none)" placeholder from labels', () => {
    const draft = parseIssueDraft(
      block('<title>T</title>\n<labels> bug , , (none) </labels>\n<body>B</body>'),
    );

    expect(draft.labels).toEqual(['bug']);
  });

  it('throws when there is no draft block', () => {
    expect(() => parseIssueDraft('I created the issue at https://github.com/a/b/issues/1')).toThrow(
      IssueDraftParseError,
    );
  });

  it('reports the raw output when the block is missing', () => {
    expect(() => parseIssueDraft('nothing structured here')).toThrow(/nothing structured here/);
  });

  it('throws when the title is empty', () => {
    expect(() => parseIssueDraft(block('<title>   </title>\n<body>B</body>'))).toThrow(
      /no <title>/,
    );
  });

  it('throws when the body is missing', () => {
    expect(() => parseIssueDraft(block('<title>T</title>'))).toThrow(/no <body>/);
  });

  it('throws when the closing tag is missing', () => {
    expect(() => parseIssueDraft('<issue-draft><title>T</title><body>B</body>')).toThrow(
      IssueDraftParseError,
    );
  });
});

describe('parseIssueDraft — repository policy fields', () => {
  function block(inner: string): string {
    return `<issue-draft>\n<title>T</title>\n<body>B</body>\n${inner}\n</issue-draft>`;
  }

  it('omits type and template entirely when the agent emitted neither', () => {
    const draft = parseIssueDraft(block(''));

    // Absent, not empty: a repository with no Issue Types must not have `--type`
    // sent for it, and `undefined` is what the provider checks.
    expect('type' in draft).toBe(false);
    expect('template' in draft).toBe(false);
  });

  it('reads the Issue Type the draft chose', () => {
    expect(parseIssueDraft(block('<type>Bug</type>')).type).toBe('Bug');
  });

  it('reads the template the draft followed', () => {
    expect(
      parseIssueDraft(block('<template>.github/ISSUE_TEMPLATE/bug.yml</template>')).template,
    ).toBe('.github/ISSUE_TEMPLATE/bug.yml');
  });

  it('treats an empty or "(none)" value as absent', () => {
    expect('type' in parseIssueDraft(block('<type>  </type>'))).toBe(false);
    expect('type' in parseIssueDraft(block('<type>(none)</type>'))).toBe(false);
    expect('template' in parseIssueDraft(block('<template>(none)</template>'))).toBe(false);
  });
});
