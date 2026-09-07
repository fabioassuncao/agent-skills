import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PORT of `frontend/src/lib/DiffDialog.test.ts` @ d8c9d5f — 2 cases, plus 1 for
 * the colour scheme, which this port resolves from the theme instead of
 * hard-coding to dark.
 */

vi.mock('./api', () => ({
  api: {
    fetchWorktreeDiff: vi.fn(),
  },
  canCall: () => true,
}));

import { api } from './api';
import DiffDialog from './DiffDialog.svelte';

const originalDialogShowModal = HTMLDialogElement.prototype.showModal;
const originalDialogClose = HTMLDialogElement.prototype.close;

describe('DiffDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('data-theme');
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement): void {
      this.open = true;
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement): void {
      this.open = false;
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-theme');
    HTMLDialogElement.prototype.showModal = originalDialogShowModal;
    HTMLDialogElement.prototype.close = originalDialogClose;
  });

  it('shows git status entries and a Cursor link when available', async () => {
    vi.mocked(api.fetchWorktreeDiff).mockResolvedValue({
      uncommitted: '',
      uncommittedTruncated: false,
      gitStatus: 'A  src/new-file.ts\nD  src/old-file.ts',
      unpushedCommits: [],
    });

    render(DiffDialog, {
      props: {
        branch: 'feature/status',
        cursorUrl: 'cursor://file/tmp/feature/status',
        onclose: vi.fn(),
      },
    });

    const statusOutput = await screen.findByText(
      (_content, node) =>
        node?.tagName === 'PRE' && node.textContent?.includes('src/new-file.ts') === true,
    );

    expect(screen.getByRole('button', { name: 'Estado do git (2)' })).toHaveClass('active');
    expect(statusOutput.textContent).toContain('A  src/new-file.ts');
    expect(statusOutput.textContent).toContain('D  src/old-file.ts');
    expect(screen.getByRole('link', { name: 'Cursor' })).toHaveAttribute(
      'href',
      'cursor://file/tmp/feature/status',
    );
  });

  const UNCOMMITTED_DIFF =
    'diff --git a/src/example.ts b/src/example.ts\nindex e69de29..4b825dc 100644\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -0,0 +1 @@\n+const value = 1;\n';

  it("renders uncommitted diffs with the app's dark color scheme", async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    vi.mocked(api.fetchWorktreeDiff).mockResolvedValue({
      uncommitted: UNCOMMITTED_DIFF,
      uncommittedTruncated: false,
      gitStatus: '',
      unpushedCommits: [],
    });

    const { container } = render(DiffDialog, {
      props: {
        branch: 'feature/diff-colors',
        onclose: vi.fn(),
      },
    });

    await screen.findByRole('button', { name: 'Diff atual' });

    expect(container.querySelector('.d2h-wrapper')).toHaveClass('d2h-dark-color-scheme');
  });

  it('treats every named palette as dark', async () => {
    document.documentElement.setAttribute('data-theme', 'nord');
    vi.mocked(api.fetchWorktreeDiff).mockResolvedValue({
      uncommitted: UNCOMMITTED_DIFF,
      uncommittedTruncated: false,
      gitStatus: '',
      unpushedCommits: [],
    });

    const { container } = render(DiffDialog, {
      props: { branch: 'feature/nord-diff', onclose: vi.fn() },
    });
    await screen.findByRole('button', { name: 'Diff atual' });
    expect(container.querySelector('.d2h-wrapper')).toHaveClass('d2h-dark-color-scheme');
  });

  it('follows the light theme rather than hard-coding dark', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    vi.mocked(api.fetchWorktreeDiff).mockResolvedValue({
      uncommitted: UNCOMMITTED_DIFF,
      uncommittedTruncated: false,
      gitStatus: '',
      unpushedCommits: [],
    });

    const { container } = render(DiffDialog, {
      props: {
        branch: 'feature/diff-colors-light',
        onclose: vi.fn(),
      },
    });

    await screen.findByRole('button', { name: 'Diff atual' });

    expect(container.querySelector('.d2h-wrapper')).not.toHaveClass('d2h-dark-color-scheme');
  });
});
