import { describe, expect, it } from 'vitest';
import { redactFailureMessage, redactSecrets } from './redact.js';

describe('redact', () => {
  it('strips provider keys, GitHub tokens, Bearer headers and env values', () => {
    const raw = [
      'sk-ant-api03-abcdefghijklmnop',
      'Authorization: Bearer eyJhbGciOi.secret',
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'OPENAI_API_KEY=sk-secretvalue1234',
    ].join('\n');
    const redacted = redactSecrets(raw);
    expect(redacted).not.toMatch(/sk-ant-/);
    expect(redacted).not.toMatch(/ghp_/);
    expect(redacted).not.toMatch(/Bearer eyJ/);
    expect(redacted).not.toMatch(/sk-secretvalue/);
    expect(redacted).toContain('[redacted]');
  });

  it('caps a failure message at 8 lines after redaction', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} sk-ant-abcdefghijkl`);
    const message = redactFailureMessage(lines.join('\n'));
    expect(message.split('\n').length).toBeLessThanOrEqual(8);
    expect(message).not.toContain('sk-ant-');
  });
});
