import { spawnSync } from 'node:child_process';
const [operation, scope = ''] = process.argv.slice(2);
if (operation === '--help') {
  console.log('policy [scope] | init [scope]. Optional read-only Issue Flow enrichment; 5-second timeout, no downloads. JSON null means unavailable.');
} else {
  const commands = { policy: ['policy', '--json', '--scope', scope], init: ['init', '--json', ...(scope ? ['--scope', scope] : [])] };
  if (!Object.hasOwn(commands, operation)) { console.error('Unknown operation'); process.exitCode = 1; }
  else {
    const result = spawnSync('issue-flow', commands[operation], { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    let value = null;
    try {
      if (!result.error && result.status === 0) {
        const parsed = JSON.parse(result.stdout);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.schemaVersion === 1 && (operation === 'policy' ? parsed.issues && parsed.git && parsed.pullRequests : Array.isArray(parsed.actions))) value = parsed;
      }
    } catch { /* unavailable enrichment */ }
    console.log(JSON.stringify(value));
  }
}
