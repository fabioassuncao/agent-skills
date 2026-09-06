import { inspectArtifact } from '../../src/core/artifact-files.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const context = args.includes('--context');
const positional = args.filter((arg) => arg !== '--json' && arg !== '--context');
if (positional[0] === '--help') {
  console.log(
    'issue <issue.md> [metadata.json]: parse/hash and validate metadata. plan <tasks.json>: validate schema and dependencies. Add --json for a versioned inspection with next eligible story. For plan, --context selects current execution facts without history. Read-only; exit 1 on invalid input.',
  );
} else {
  const [operation, path, metadata] = positional;
  const result =
    positional.length > 3 || (context && operation !== 'plan')
      ? {
          schemaVersion: 1,
          ok: false,
          data: null,
          errors: [{ code: 'arguments', path: '', message: 'Invalid arguments' }],
        }
      : await inspectArtifact(context ? 'context' : operation, path, metadata);
  if (json || context) console.log(JSON.stringify(result));
  else if (!result.ok) console.error(result.errors.map((error) => error.message).join('\n'));
  else if (operation === 'plan')
    console.log(JSON.stringify({ valid: true, stories: result.data.counts.total }));
  else console.log(JSON.stringify(result.data));
  process.exitCode = result.ok ? 0 : 1;
}
