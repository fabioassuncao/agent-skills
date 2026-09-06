import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AskUserQuestionCard from './AskUserQuestionCard.svelte';
import type { AskUserQuestionInput } from './types';

/** PORT of `frontend/src/lib/AskUserQuestionCard.test.ts` @ d8c9d5f — 5 cases. */

const singleSelect: AskUserQuestionInput = {
  questions: [
    {
      question: 'Você prefere gatos ou cachorros?',
      header: 'Tipo de bicho',
      multiSelect: false,
      options: [
        { label: 'Gatos', description: 'Independentes.' },
        { label: 'Cachorros', description: 'Leais.' },
      ],
    },
  ],
};

const multiSelect: AskUserQuestionInput = {
  questions: [
    {
      question: 'Quais coberturas?',
      header: 'Coberturas',
      multiSelect: true,
      options: [{ label: 'Queijo' }, { label: 'Azeitona' }],
    },
  ],
};

describe('AskUserQuestionCard', () => {
  afterEach(() => cleanup());

  it('renders the question, options and a custom input', () => {
    render(AskUserQuestionCard, {
      props: { input: singleSelect, disabled: false, onSubmit: vi.fn() },
    });

    expect(screen.getByText('Você prefere gatos ou cachorros?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Gatos/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cachorros/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Resposta livre…')).toBeInTheDocument();
  });

  it('auto-sends a single-select answer on click', async () => {
    const onSubmit = vi.fn();
    render(AskUserQuestionCard, { props: { input: singleSelect, disabled: false, onSubmit } });

    await fireEvent.click(screen.getByRole('button', { name: /Gatos/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('Tipo de bicho: Gatos');
  });

  it('auto-sends a typed custom answer on Enter', async () => {
    const onSubmit = vi.fn();
    render(AskUserQuestionCard, { props: { input: singleSelect, disabled: false, onSubmit } });

    const input = screen.getByPlaceholderText('Resposta livre…');
    await fireEvent.input(input, { target: { value: 'Um peixinho dourado' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('Tipo de bicho: Um peixinho dourado');
  });

  it('uses a submit button for multi-select and joins selections', async () => {
    const onSubmit = vi.fn();
    render(AskUserQuestionCard, { props: { input: multiSelect, disabled: false, onSubmit } });

    await fireEvent.click(screen.getByRole('button', { name: 'Queijo' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Azeitona' }));
    expect(onSubmit).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Enviar resposta' }));
    expect(onSubmit).toHaveBeenCalledWith('Coberturas: Queijo, Azeitona');
  });

  it('does not submit when disabled', async () => {
    const onSubmit = vi.fn();
    render(AskUserQuestionCard, { props: { input: singleSelect, disabled: true, onSubmit } });

    await fireEvent.click(screen.getByRole('button', { name: /Gatos/ }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
