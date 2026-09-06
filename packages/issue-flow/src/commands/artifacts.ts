import { inspectArtifact } from '../core/artifact-files.js';

export async function runArtifacts(
  operation: string,
  path?: string,
  metadata?: string,
  json = false,
): Promise<number> {
  const result = await inspectArtifact(operation, path, metadata);
  if (json) console.log(JSON.stringify(result));
  else if (!result.ok)
    console.error(
      result.errors.map((error) => `${error.code}: ${error.path}: ${error.message}`).join('\n'),
    );
  else console.log(JSON.stringify(result.data, null, 2));
  return result.ok ? 0 : 1;
}
