import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCodexConversationWithDeadline } from './conversation.js';

describe('Linear conversation export', () => {
  afterEach(() => vi.useRealTimers());

  it('bounds Codex thread reads and closes the app-server client', async () => {
    vi.useFakeTimers();
    const client = {
      threadRead: vi.fn(() => new Promise(() => {})),
      close: vi.fn(),
    };

    const reading = readCodexConversationWithDeadline(client as never, 'thread-1', 25);
    const rejected = expect(reading).rejects.toMatchObject({
      message: 'Codex conversation read timed out.',
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(25);

    await rejected;
    expect(client.threadRead).toHaveBeenCalledWith('thread-1', true);
    expect(client.close).toHaveBeenCalledOnce();
  });
});
