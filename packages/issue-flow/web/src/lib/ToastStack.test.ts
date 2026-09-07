import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ToastStack from './ToastStack.svelte';
import type { ToastItem } from './types';

afterEach(() => {
  cleanup();
});

function createToast(overrides: Partial<ToastItem> = {}): ToastItem {
  return {
    id: 'ui:1',
    source: 'ui',
    tone: 'info',
    message: 'Texto da notificação',
    detail: 'https://example.com/notifications/1',
    ...overrides,
  } as ToastItem;
}

describe('ToastStack', () => {
  it('uses content-fit sizing with a capped max width', () => {
    render(ToastStack, {
      props: {
        toasts: [createToast()],
        ondismiss: vi.fn(),
      },
    });

    const alert = screen.getByRole('alert');
    const stack = alert.parentElement;

    expect(stack).not.toBeNull();
    expect(stack?.className).toContain('items-end');
    expect(alert.className).toContain('w-fit');
    expect(alert.className).toContain('max-w-[min(48ch,calc(100vw-2rem))]');
  });

  it('wraps toast content instead of truncating it', () => {
    const message =
      'Esta é uma mensagem de notificação bem longa que deve quebrar linha dentro do aviso em vez de ser truncada';
    const detail = 'https://example.com/notifications/caminho/bem/longo/que/deve/quebrar';

    render(ToastStack, {
      props: {
        toasts: [createToast({ message, detail })],
        ondismiss: vi.fn(),
      },
    });

    const messageNode = screen.getByText(message);
    const detailNode = screen.getByText(detail);

    expect(messageNode.className).toContain('whitespace-normal');
    expect(messageNode.className).toContain('break-words');
    expect(messageNode.className).not.toContain('truncate');
    expect(detailNode.className).toContain('whitespace-normal');
    expect(detailNode.className).toContain('break-all');
    expect(detailNode.className).not.toContain('truncate');
  });

  it('keeps toasts dismissible', async () => {
    const ondismiss = vi.fn();

    render(ToastStack, {
      props: {
        toasts: [createToast()],
        ondismiss,
      },
    });

    const dismissButton = screen.getByRole('button', { name: 'Dispensar aviso' });

    await fireEvent.click(dismissButton);

    expect(ondismiss).toHaveBeenCalledWith('ui:1');
  });
});
