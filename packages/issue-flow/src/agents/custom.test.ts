// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${PROMPT}` is the
// literal placeholder syntax of a custom agent's command template, written by
// the user in configuration. It is data this module substitutes, never a
// template literal that lost its backticks — which is exactly what these cases
// exist to pin down.

import { describe, expect, it } from 'vitest';
import {
  buildCustomAgentCommand,
  buildCustomAgentExports,
  customAgentCapabilities,
  renderCustomCommandTemplate,
} from './custom.js';

/**
 * Ported from the custom-agent path of WebMux
 * `backend/src/services/agent-service.ts` @ d8c9d5f. §45.2-L absorbs only this
 * from the upstream's agent layer, and the reason to have it at all is that it
 * lets someone run a harness this project has never heard of.
 */
const context = {
  prompt: 'do the thing',
  systemPrompt: 'be careful',
  worktreePath: '/wt/feature',
  repoRoot: '/repo',
  branch: 'feature',
  profileName: 'default',
};

describe('renderCustomCommandTemplate', () => {
  // A variable reference, not the value: that is what keeps a prompt containing
  // `'` or `$(…)` from becoming part of the command line.
  it('turns a placeholder into a reference to the variable that carries it', () => {
    expect(renderCustomCommandTemplate('my-agent --prompt "${PROMPT}"')).toBe(
      'my-agent --prompt "$ISSUE_FLOW_AGENT_PROMPT"',
    );
    expect(renderCustomCommandTemplate('cd ${WORKTREE_PATH} && run ${BRANCH}')).toBe(
      'cd $ISSUE_FLOW_AGENT_WORKTREE_PATH && run $ISSUE_FLOW_AGENT_BRANCH',
    );
  });

  it('replaces every occurrence, not only the first', () => {
    expect(renderCustomCommandTemplate('${BRANCH} ${BRANCH}')).toBe(
      '$ISSUE_FLOW_AGENT_BRANCH $ISSUE_FLOW_AGENT_BRANCH',
    );
  });

  // The template belongs to the user and may reference a variable of their own.
  it('leaves an unknown placeholder alone', () => {
    expect(renderCustomCommandTemplate('run ${MY_OWN_THING}')).toBe('run ${MY_OWN_THING}');
  });
});

describe('buildCustomAgentExports', () => {
  it('exports every value the template can reference', () => {
    const exports = buildCustomAgentExports(context);
    expect(exports).toContain("export ISSUE_FLOW_AGENT_PROMPT='do the thing'");
    expect(exports).toContain("export ISSUE_FLOW_AGENT_SYSTEM_PROMPT='be careful'");
    expect(exports).toContain("export ISSUE_FLOW_AGENT_WORKTREE_PATH='/wt/feature'");
    expect(exports).toContain("export ISSUE_FLOW_AGENT_REPO_PATH='/repo'");
    expect(exports).toContain("export ISSUE_FLOW_AGENT_BRANCH='feature'");
    expect(exports).toContain("export ISSUE_FLOW_AGENT_PROFILE='default'");
  });

  // An absent value becomes an empty variable rather than an unset one, so a
  // template referencing it expands to nothing instead of to the literal text.
  it('exports an empty value rather than omitting the variable', () => {
    const exports = buildCustomAgentExports({ ...context, prompt: undefined });
    expect(exports).toContain("export ISSUE_FLOW_AGENT_PROMPT=''");
  });

  it('quotes a value that would otherwise break the command', () => {
    const exports = buildCustomAgentExports({ ...context, prompt: "'; rm -rf ~; echo '" });
    expect(exports).toContain("export ISSUE_FLOW_AGENT_PROMPT=''\\''; rm -rf ~; echo '\\'''");
  });
});

describe('buildCustomAgentCommand', () => {
  const definition = {
    id: 'my-agent',
    startCommand: 'my-agent start --prompt "${PROMPT}"',
    resumeCommand: 'my-agent resume --prompt "${PROMPT}"',
  };

  it('exports the context, then runs the rendered template', () => {
    const command = buildCustomAgentCommand({ definition, context });
    expect(command.startsWith("export ISSUE_FLOW_AGENT_PROMPT='do the thing';")).toBe(true);
    expect(command.endsWith('my-agent start --prompt "$ISSUE_FLOW_AGENT_PROMPT"')).toBe(true);
  });

  it('uses the resume command when asked and one exists', () => {
    expect(buildCustomAgentCommand({ definition, context, launchMode: 'resume' })).toContain(
      'my-agent resume',
    );
  });

  it('falls back to the start command when the agent cannot resume', () => {
    expect(
      buildCustomAgentCommand({
        definition: { id: 'x', startCommand: 'x start' },
        context,
        launchMode: 'resume',
      }),
    ).toContain('x start');
  });
});

describe('customAgentCapabilities', () => {
  // This project knows nothing about the binary beyond its command line, so it
  // cannot claim to read its history or interrupt it meaningfully.
  it('claims only what a command line can support', () => {
    expect(customAgentCapabilities({ id: 'x', startCommand: 'x' })).toEqual({
      terminal: true,
      structuredChat: false,
      conversationHistory: false,
      interrupt: false,
      resume: false,
    });
  });

  it('claims resume only when a resume command was actually given', () => {
    expect(
      customAgentCapabilities({ id: 'x', startCommand: 'x', resumeCommand: 'x --resume' }).resume,
    ).toBe(true);
  });
});
