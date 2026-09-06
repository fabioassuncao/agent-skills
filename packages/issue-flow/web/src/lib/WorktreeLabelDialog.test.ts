import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorktreeLabelDialog from './WorktreeLabelDialog.svelte';

/** PORT of `frontend/src/lib/WorktreeLabelDialog.test.ts` @ d8c9d5f — 5 cases. */

const originalDialogShowModal = HTMLDialogElement.prototype.showModal;
const originalDialogClose = HTMLDialogElement.prototype.close;

function renderDialog(
  overrides: {
    initialLabel?: string | null;
    onconfirm?: (label: string) => void;
    onclear?: () => void;
    oncancel?: () => void;
  } = {},
): void {
  render(WorktreeLabelDialog, {
    props: {
      branch: 'feature/search',
      initialLabel: null,
      loading: false,
      error: '',
      onconfirm: overrides.onconfirm ?? vi.fn(),
      onclear: overrides.onclear ?? vi.fn(),
      oncancel: overrides.oncancel ?? vi.fn(),
      ...overrides,
    },
  });
}

describe('WorktreeLabelDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement): void {
      this.open = true;
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement): void {
      this.open = false;
    });
  });

  afterEach(() => {
    cleanup();
    HTMLDialogElement.prototype.showModal = originalDialogShowModal;
    HTMLDialogElement.prototype.close = originalDialogClose;
  });

  it('disables clear and save when there is no initial label', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Limpar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled();
  });

  it('clears an existing label', async () => {
    const onclear = vi.fn();
    renderDialog({ initialLabel: 'Ranking da busca', onclear });

    await fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));

    expect(onclear).toHaveBeenCalledTimes(1);
  });

  it('submits trimmed changed labels', async () => {
    const onconfirm = vi.fn();
    renderDialog({ initialLabel: 'Ranking da busca', onconfirm });

    await fireEvent.input(screen.getByLabelText('Rótulo'), {
      target: { value: '  Filtros da busca  ' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(onconfirm).toHaveBeenCalledWith('Filtros da busca');
  });

  it('does not submit unchanged labels', async () => {
    const onconfirm = vi.fn();
    renderDialog({ initialLabel: 'Ranking da busca', onconfirm });

    expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(onconfirm).not.toHaveBeenCalled();
  });

  it('cancels without saving', async () => {
    const oncancel = vi.fn();
    const onconfirm = vi.fn();
    renderDialog({ initialLabel: 'Ranking da busca', oncancel, onconfirm });

    await fireEvent.input(screen.getByLabelText('Rótulo'), {
      target: { value: 'Filtros da busca' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(oncancel).toHaveBeenCalledTimes(1);
    expect(onconfirm).not.toHaveBeenCalled();
  });
});
