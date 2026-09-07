// biome-ignore-all lint/suspicious/noTemplateCurlyInString: placeholders are data.
import { describe, expect, it } from 'vitest';
import {
  buildCustomAgentArgv,
  buildCustomAgentEnvironment,
  customAgentCapabilities,
  parseCustomAgentCommand,
  renderCustomCommandTemplate,
} from './custom.js';

const context = {
  prompt: 'do the thing',
  systemPrompt: 'be careful',
  worktreePath: '/wt/feature',
  repoRoot: '/repo',
  branch: 'feature',
  profileName: 'default',
  permission: 'workspace' as const,
};

describe('renderCustomCommandTemplate', () => {
  it('replaces every known placeholder with an environment reference, never its value', () => {
    expect(renderCustomCommandTemplate('my-agent --prompt "${PROMPT}"')).toBe(
      'my-agent --prompt "${ISSUE_FLOW_AGENT_PROMPT}"',
    );
    expect(renderCustomCommandTemplate('${BRANCH} ${BRANCH}')).toBe(
      '${ISSUE_FLOW_AGENT_BRANCH} ${ISSUE_FLOW_AGENT_BRANCH}',
    );
  });

  it('keeps adjacent suffixes outside the exact environment reference token', () => {
    expect(renderCustomCommandTemplate('${PROMPT}_suffix ${PROMPT}X')).toBe(
      '${ISSUE_FLOW_AGENT_PROMPT}_suffix ${ISSUE_FLOW_AGENT_PROMPT}X',
    );
  });

  it('leaves unknown placeholders alone', () => {
    expect(renderCustomCommandTemplate('run ${MY_OWN_THING}')).toBe('run ${MY_OWN_THING}');
  });
});

describe('buildCustomAgentEnvironment', () => {
  it('provides every context value and the semantic permission', () => {
    const env = buildCustomAgentEnvironment(context);
    expect(env).toMatchObject({
      ISSUE_FLOW_AGENT_PROMPT: 'do the thing',
      ISSUE_FLOW_AGENT_SYSTEM_PROMPT: 'be careful',
      ISSUE_FLOW_AGENT_WORKTREE_PATH: '/wt/feature',
      ISSUE_FLOW_AGENT_REPO_PATH: '/repo',
      ISSUE_FLOW_AGENT_BRANCH: 'feature',
      ISSUE_FLOW_AGENT_PROFILE: 'default',
      ISSUE_FLOW_AGENT_PERMISSION: 'workspace',
    });
  });

  it('keeps hostile text in one environment argv element', () => {
    const env = buildCustomAgentEnvironment({ ...context, prompt: "'; rm -rf ~; echo '" });
    expect(env.ISSUE_FLOW_AGENT_PROMPT).toBe("'; rm -rf ~; echo '");
  });
});

describe('parseCustomAgentCommand', () => {
  it('supports quoted, empty, and escaped arguments without invoking a shell', () => {
    expect(parseCustomAgentCommand(`tool --name 'two words' "" escaped\\ value`)).toEqual([
      'tool',
      '--name',
      'two words',
      '',
      'escaped value',
    ]);
  });

  it('rejects malformed quoting instead of guessing a command', () => {
    expect(() => parseCustomAgentCommand(`tool 'unfinished`)).toThrow('unclosed quote');
    expect(() => parseCustomAgentCommand('tool trailing\\')).toThrow('incomplete escape');
  });
});

describe('buildCustomAgentArgv', () => {
  const definition = {
    id: 'my-agent',
    label: 'My agent',
    startCommand: 'my-agent start --prompt "${PROMPT}"',
    resumeCommand: 'my-agent resume --prompt "${PROMPT}"',
  };

  it('returns environment and command as discrete argv entries', () => {
    const argv = buildCustomAgentArgv({ definition });
    expect(argv).toEqual(['my-agent', 'start', '--prompt', '${ISSUE_FLOW_AGENT_PROMPT}']);
    expect(argv.join(' ')).not.toContain(context.prompt);
  });

  it('uses resume when available and start otherwise', () => {
    expect(buildCustomAgentArgv({ definition, launchMode: 'resume' }).slice(-4)).toEqual([
      'my-agent',
      'resume',
      '--prompt',
      '${ISSUE_FLOW_AGENT_PROMPT}',
    ]);
    expect(
      buildCustomAgentArgv({
        definition: { id: 'x', label: 'X', startCommand: 'x start' },
        launchMode: 'resume',
      }).slice(-2),
    ).toEqual(['x', 'start']);
  });

  it('keeps hostile shell syntax in one argv value', () => {
    const argv = buildCustomAgentArgv({
      definition: { id: 'x', label: 'X', startCommand: 'x "${PROMPT}"' },
    });
    expect(argv.slice(-2)).toEqual(['x', '${ISSUE_FLOW_AGENT_PROMPT}']);
    expect(argv.join(' ')).not.toContain('touch');
  });
});

describe('customAgentCapabilities', () => {
  it('claims only terminal and configured resume support', () => {
    expect(customAgentCapabilities({ id: 'x', label: 'X', startCommand: 'x' })).toEqual({
      terminal: true,
      structuredChat: false,
      conversationHistory: false,
      interrupt: false,
      resume: false,
    });
    expect(
      customAgentCapabilities({
        id: 'x',
        label: 'X',
        startCommand: 'x',
        resumeCommand: 'x --resume',
      }).resume,
    ).toBe(true);
  });
});
