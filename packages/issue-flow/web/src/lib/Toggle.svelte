<script lang="ts">
  /**
   * PORT of `frontend/src/lib/Toggle.svelte` @ d8c9d5f (103 lines).
   *
   * `preventMouseFocus` exists for one caller — the inline toggle inside
   * `BranchSelector`'s dropdown. Focusing it on mousedown moves focus out of
   * the search field, which closes the dropdown the toggle lives in, so the
   * click never lands. Keyboard focus is unaffected.
   *
   * The scoped styles below read the Issue Flow role tokens directly rather
   * than Tailwind's `--color-*`: `@theme inline` substitutes those into utility
   * classes and never registers them as custom properties, so `var(--color-…)`
   * in a scoped style would resolve to nothing. Every component here does the
   * same.
   */

  let {
    checked = $bindable(false),
    id,
    disabled = false,
    size = 'default',
    preventMouseFocus = false,
    ontoggle,
    'aria-label': ariaLabel,
  }: {
    checked: boolean;
    id?: string;
    disabled?: boolean;
    size?: 'default' | 'sm';
    preventMouseFocus?: boolean;
    ontoggle?: (checked: boolean) => void;
    'aria-label'?: string;
  } = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={ariaLabel}
  {id}
  {disabled}
  onmousedown={(event) => {
    if (!preventMouseFocus) return;
    event.preventDefault();
  }}
  onclick={() => {
    checked = !checked;
    ontoggle?.(checked);
  }}
  class="toggle"
  class:on={checked}
  class:sm={size === 'sm'}
>
  <span class="knob"></span>
</button>

<style>
  .toggle {
    position: relative;
    width: 32px;
    height: 18px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    background: var(--surface-sunken);
    cursor: pointer;
    padding: 0;
    transition:
      background 0.15s,
      border-color 0.15s;
    flex-shrink: 0;
  }

  .toggle:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toggle.on {
    background: var(--accent);
    border-color: var(--accent);
  }

  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: var(--radius-pill);
    background: var(--accent-text);
    transition: transform 0.15s;
  }

  .toggle:not(.on) .knob {
    background: var(--text-muted);
  }

  .toggle.on .knob {
    transform: translateX(14px);
  }

  .toggle.sm {
    width: 24px;
    height: 14px;
  }

  .toggle.sm .knob {
    top: 1px;
    left: 1px;
    width: 10px;
    height: 10px;
  }

  .toggle.sm.on .knob {
    transform: translateX(10px);
  }

  @media (prefers-reduced-motion: reduce) {
    .toggle,
    .knob {
      transition: none;
    }
  }
</style>
