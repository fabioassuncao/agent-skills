import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createClaudeStreamReader } from './claude.js';
import { CodexAppServerClient } from './codex.js';
import { toCodexConversationState } from './codex-conversation.js';

/**
 * The structured channel against the real provider binaries.
 *
 * Both flags are probed **synchronously at module load**: `it.runIf` is
 * evaluated while the file is being collected, so a flag assigned in
 * `beforeAll` would still be false and every case would skip in silence.
 *
 * `codex app-server` is a local handshake and needs no credentials, so it is
 * gated on the binary alone. Talking to Claude costs a real turn and needs
 * authentication, so that one also needs `ISSUE_FLOW_E2E_CLAUDE=1`.
 */
const codexAvailable = spawnSync('codex', ['--version']).status === 0;
const claudeAvailable = spawnSync('claude', ['--version']).status === 0;
const claudeEnabled = claudeAvailable && process.env.ISSUE_FLOW_E2E_CLAUDE === '1';

const HANDSHAKE_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} did not answer within ${HANDSHAKE_TIMEOUT_MS} ms`)),
        HANDSHAKE_TIMEOUT_MS,
      ).unref(),
    ),
  ]);
}

describe('codex app-server', () => {
  // The whole point of the port: the handshake, the framing and the schemas
  // have to match a real `codex app-server`, not a fake that agrees with them.
  it.runIf(codexAvailable)(
    'completes the handshake and lists threads',
    async () => {
      const client = new CodexAppServerClient({ clientName: 'issue-flow-test' });
      try {
        const listed = await withTimeout(client.threadList({ limit: 1 }), 'thread/list');
        expect(Array.isArray(listed.data)).toBe(true);
        for (const thread of listed.data) {
          // Every thread the real server returns must survive the translation
          // the panel depends on.
          expect(toCodexConversationState(thread).conversationId).toBe(thread.id);
        }
      } finally {
        client.close();
      }
    },
    HANDSHAKE_TIMEOUT_MS + 5_000,
  );

  // §45.2-B against the real daemon: killing it must settle every promise.
  it.runIf(codexAvailable)(
    'rejects an in-flight request when the daemon is killed',
    async () => {
      const client = new CodexAppServerClient({ clientName: 'issue-flow-test' });
      await withTimeout(client.threadList({ limit: 1 }), 'thread/list');

      const pending = client.threadList({ limit: 1 });
      client.close();
      await expect(withTimeout(pending, 'post-kill thread/list')).rejects.toThrow();
    },
    HANDSHAKE_TIMEOUT_MS + 5_000,
  );
});

describe('claude stream reader', () => {
  // Reads a real `stream-json` turn end to end. Guarded behind an explicit env
  // flag because it spends a real Claude turn.
  it.runIf(claudeEnabled)(
    'reads a real turn into ordered messages with stable ids',
    async () => {
      const { execa } = await import('execa');
      const subprocess = execa(
        'claude',
        [
          '-p',
          '--verbose',
          '--output-format',
          'stream-json',
          '--include-partial-messages',
          '--',
          'Reply with exactly the word: pong',
        ],
        { reject: false, buffer: true },
      );
      const result = await subprocess;

      const reader = createClaudeStreamReader();
      const events = (result.stdout ?? '')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => reader.read(line));

      expect(reader.sessionId).toBeTruthy();
      expect(events.some((event) => event.type === 'complete')).toBe(true);

      const ids = events.flatMap((event) => (event.type === 'message' ? [event.message.id] : []));
      // Ids are unique per block: the whole point of `${messageId}:${index}`.
      expect(new Set(ids).size).toBe(ids.length);
    },
    120_000,
  );
});
