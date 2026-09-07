import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAgentSessionContext } from '../agents/session/context.js';
import type { AgentSessionTab } from '../agents/session/tabs.js';
import { runTabClose, runTabCreate, runTabList, runTabSwitch } from './tab.js';

const context = {} as ResolvedAgentSessionContext;
const root: AgentSessionTab = {
  tabId: 'session-root',
  sessionId: 'session-root',
  kind: 'root',
  label: 'Root',
  seq: null,
  paneId: '%1',
  createdAt: '2026-09-06T12:00:00.000Z',
};
const fork: AgentSessionTab = {
  tabId: 'session-fork',
  sessionId: 'session-fork',
  kind: 'fork',
  label: 'Fork 1',
  seq: 1,
  paneId: '%2',
  createdAt: '2026-09-06T12:01:00.000Z',
};

describe('tab CLI', () => {
  it('emits list JSON without decorative output', async () => {
    const raw = vi.fn();
    const log = vi.fn();
    expect(
      await runTabList(
        'feature',
        { json: true },
        {
          resolveContext: async () => context,
          list: async () => ({ tabs: [root, fork], activeTabId: fork.tabId }),
          raw,
          log,
        },
      ),
    ).toBe(0);
    expect(log).not.toHaveBeenCalled();
    expect(JSON.parse(String(raw.mock.calls[0]?.[0]))).toEqual({
      schemaVersion: 1,
      branch: 'feature',
      tabs: [root, fork],
      activeTabId: fork.tabId,
    });
  });

  it('uses the shared create and switch domain operations', async () => {
    const create = vi.fn(async () => fork);
    const select = vi.fn(async () => fork);
    const raw = vi.fn();
    const deps = { resolveContext: async () => context, create, select, raw };

    await expect(runTabCreate('feature', { json: true }, deps)).resolves.toBe(0);
    await expect(runTabSwitch('feature', fork.tabId, { json: true }, deps)).resolves.toBe(0);
    expect(create).toHaveBeenCalledWith(context, 'feature');
    expect(select).toHaveBeenCalledWith(context, 'feature', fork.tabId);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('refuses destructive close without confirmation and honors explicit confirmation', async () => {
    const close = vi.fn(async () => undefined);
    const error = vi.fn();
    const common = {
      resolveContext: async () => context,
      close,
      error,
      interactive: false,
    };

    await expect(runTabClose('feature', fork.tabId, {}, common)).resolves.toBe(1);
    expect(close).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--yes'));

    await expect(runTabClose('feature', fork.tabId, { yes: true }, common)).resolves.toBe(0);
    expect(close).toHaveBeenCalledWith(context, 'feature', fork.tabId);
  });
});
