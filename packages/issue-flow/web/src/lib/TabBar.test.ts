import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TabBar from './TabBar.svelte';
import type { WorktreeTab } from './types';

const tabs: WorktreeTab[] = [
  {
    tabId: 'session-root',
    sessionId: 'session-root',
    kind: 'root',
    label: 'Root',
    seq: null,
    paneId: '%1',
    createdAt: '2026-09-06T12:00:00.000Z',
  },
  {
    tabId: 'session-fork',
    sessionId: 'session-fork',
    kind: 'fork',
    label: 'Fork 1',
    seq: 1,
    paneId: '%2',
    createdAt: '2026-09-06T12:01:00.000Z',
  },
];

describe('TabBar', () => {
  afterEach(() => cleanup());

  it('keeps root reachable, closes only forks and supports roving keyboard focus', async () => {
    const onselect = vi.fn();
    const ondelete = vi.fn();
    render(TabBar, {
      props: {
        tabs,
        activeTabId: tabs[0]?.tabId ?? null,
        oncreate: vi.fn(),
        onselect,
        ondelete,
      },
    });

    const renderedTabs = screen.getAllByRole('tab');
    expect(renderedTabs).toHaveLength(2);
    expect(renderedTabs[0]).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('button', { name: 'Fechar Root' })).not.toBeInTheDocument();

    await fireEvent.keyDown(renderedTabs[0] as HTMLElement, { key: 'ArrowRight' });
    expect(onselect).toHaveBeenCalledWith('session-fork');
    expect(document.activeElement).toBe(renderedTabs[1]);

    await fireEvent.click(screen.getByRole('button', { name: 'Fechar Fork 1' }));
    expect(ondelete).toHaveBeenCalledWith('session-fork');
    expect(screen.getByRole('button', { name: 'Nova sessão derivada' })).toBeEnabled();
  });
});
