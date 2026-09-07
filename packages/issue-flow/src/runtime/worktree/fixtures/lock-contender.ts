import { withWorktreeBranchLock } from '../lock.js';

const lockDir = process.argv[2];
if (lockDir === undefined) process.exit(3);

try {
  await withWorktreeBranchLock('project', 'feature', async () => {}, { lockDir });
  process.stdout.write('acquired\n');
  process.exitCode = 1;
} catch (error) {
  process.stdout.write(
    error instanceof Error && error.message.includes('is being changed by')
      ? 'blocked\n'
      : 'unexpected\n',
  );
  process.exitCode =
    error instanceof Error && error.message.includes('is being changed by') ? 0 : 2;
}
