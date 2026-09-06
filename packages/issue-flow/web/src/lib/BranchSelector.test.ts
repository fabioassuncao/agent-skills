import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BranchSelector from './BranchSelector.svelte';

/**
 * PORT of `frontend/src/lib/BranchSelector.test.ts` @ d8c9d5f — 4 cases.
 *
 * The first two exist for the same failure from two directions: the dropdown
 * closes on `focusout`, so reopening it has to re-focus the search field or the
 * user types into nothing.
 */

const BRANCHES = [{ name: 'main' }, { name: 'release/base' }];

describe('BranchSelector', () => {
  afterEach(() => {
    cleanup();
  });

  it('auto-focuses the search input each time it is reopened after escape', async () => {
    render(BranchSelector, {
      props: {
        label: 'Branch existente',
        branches: BRANCHES,
        initialOpen: true,
        onselect: vi.fn(),
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Buscar em Branch existente')).toHaveFocus();
    });

    await fireEvent.keyDown(screen.getByLabelText('Buscar em Branch existente'), {
      key: 'Escape',
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('Buscar em Branch existente')).not.toBeInTheDocument();
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Branch existente' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Buscar em Branch existente')).toHaveFocus();
    });
  });

  it('auto-focuses the search input each time it is reopened after focus leaves the selector', async () => {
    render(BranchSelector, {
      props: {
        label: 'Branch base',
        branches: BRANCHES,
        onselect: vi.fn(),
      },
    });

    const trigger = screen.getByRole('button', { name: 'Branch base' });
    await fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByLabelText('Buscar em Branch base')).toHaveFocus();
    });

    await fireEvent.focusOut(screen.getByLabelText('Buscar em Branch base'), {
      relatedTarget: document.body,
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('Buscar em Branch base')).not.toBeInTheDocument();
    });

    await fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByLabelText('Buscar em Branch base')).toHaveFocus();
    });
  });

  it('keeps the selector open when the inline toggle row is clicked', async () => {
    const onInlineToggle = vi.fn();

    render(BranchSelector, {
      props: {
        label: 'Branch existente',
        branches: BRANCHES,
        initialOpen: true,
        inlineToggleLabel: 'incluir remotas',
        inlineToggleChecked: false,
        oninlinetoggle: onInlineToggle,
        onselect: vi.fn(),
      },
    });

    const search = await screen.findByLabelText('Buscar em Branch existente');
    const availabilityRow = screen.getByText(/2\s+disponíveis/).parentElement as HTMLElement;

    await fireEvent.mouseDown(availabilityRow);
    await fireEvent.click(availabilityRow);

    expect(onInlineToggle).not.toHaveBeenCalled();
    expect(search).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Branch existente' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('keeps rendering the current branch list while a refresh is in flight', async () => {
    render(BranchSelector, {
      props: {
        label: 'Branch existente',
        branches: BRANCHES,
        loading: true,
        initialOpen: true,
        onselect: vi.fn(),
      },
    });

    expect(await screen.findByRole('button', { name: 'main' })).toBeInTheDocument();
    expect(screen.getByText('Atualizando…')).toBeInTheDocument();
    expect(screen.queryByText('Carregando branches…')).not.toBeInTheDocument();
  });
});
