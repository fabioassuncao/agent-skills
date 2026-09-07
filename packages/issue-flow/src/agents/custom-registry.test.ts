// biome-ignore-all lint/suspicious/noTemplateCurlyInString: placeholders are user data.
import { describe, expect, it } from 'vitest';
import {
  findRegisteredAgent,
  listAgentDetails,
  normalizeCustomAgentId,
  validateCustomAgentInput,
} from './custom-registry.js';

describe('custom agent registry', () => {
  it('lists all five built-ins before sorted custom agents', () => {
    const agents = listAgentDetails({
      zed: { id: 'zed', label: 'Zed', startCommand: 'zed' },
      alpha: { id: 'alpha', label: 'Alpha', startCommand: 'alpha', resumeCommand: 'alpha resume' },
      claude: { id: 'claude', label: 'Collision', startCommand: 'nope' },
    });
    expect(agents.map((agent) => agent.id)).toEqual([
      'claude',
      'codex',
      'cursor',
      'antigravity',
      'opencode',
      'alpha',
      'zed',
    ]);
    expect(agents.find((agent) => agent.id === 'alpha')?.capabilities.resume).toBe(true);
    expect(findRegisteredAgent({}, 'missing')).toBeNull();
  });

  it('normalizes labels and reports prompt/resume warnings', () => {
    expect(normalizeCustomAgentId(' Gemini CLI! ')).toBe('gemini-cli');
    expect(normalizeCustomAgentId('!!!')).toBe('agent');
    expect(validateCustomAgentInput({ label: 'X', startCommand: 'x' }).warnings).toHaveLength(2);
    expect(
      validateCustomAgentInput({
        label: 'X',
        startCommand: 'x "${PROMPT}"',
        resumeCommand: 'x resume',
      }).warnings,
    ).toEqual([]);
  });
});
