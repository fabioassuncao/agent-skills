import tab from '@bomb.sh/tab/commander';
import type { Command } from 'commander';

/** Attach Bombshell's protocol and script generator to the registered Commander tree. */
export function attachCompletion(program: Command): ReturnType<typeof tab> {
  return tab(program);
}
