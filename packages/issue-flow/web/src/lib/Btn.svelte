<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  /**
   * PORT of `frontend/src/lib/Btn.svelte` @ d8c9d5f (38 lines).
   *
   * One change: the upstream's `text-white` on the filled variants becomes
   * `text-accent-text`. White reads fine on a light-theme accent and gives
   * 2.98:1 on the dark theme's light fills — the panel already learned this and
   * inverts the token instead (`web/AGENTS.md`, contrast table).
   */

  let {
    variant = 'default',
    small = false,
    class: extraClass = '',
    children,
    ...rest
  }: HTMLButtonAttributes & {
    variant?: 'default' | 'cta' | 'danger' | 'accent-outline' | 'danger-outline';
    small?: boolean;
    children: Snippet;
  } = $props();

  const base =
    'rounded-md border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

  const sizes: Record<string, string> = {
    normal: 'px-3 py-1.5 text-xs',
    small: 'px-2.5 py-1 text-[11px] font-semibold',
  };

  const variants: Record<string, string> = {
    default: 'border-edge bg-surface text-primary hover:bg-hover',
    cta: 'border-accent bg-accent text-accent-text hover:opacity-90',
    danger: 'border-danger bg-danger text-accent-text hover:opacity-90',
    'accent-outline': 'border-accent text-accent bg-surface hover:bg-accent/10',
    'danger-outline': 'border-danger text-danger bg-surface hover:bg-danger/10',
  };
</script>

<button
  class="{base} {sizes[small ? 'small' : 'normal']} {variants[variant]} {extraClass}"
  {...rest}
>
  {@render children()}
</button>
