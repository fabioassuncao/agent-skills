import type { PolicySource, RepositoryPolicy } from '../policy/index.js';
import { loadRepositoryPolicy } from '../policy/index.js';
import { printError, printInfo, printWarning } from '../ui/logger.js';

/**
 * `issue-flow policy [--scope <dir>] [--json]`.
 *
 * The inspection surface of the policy layer, and the only one for now: this
 * issue delivers the foundation, so no prompt and no skill consumes
 * `loadRepositoryPolicy()` yet.
 *
 * It exists for two audiences. A human debugging a wrong discovery reads the
 * default output, where every section names the files it came from. The Agent
 * Skills read `--json`: they are markdown and cannot import TypeScript, so a
 * versioned JSON document on stdout is the only bridge available to them —
 * which is why `schemaVersion` is part of the payload rather than of the CLI.
 *
 * That makes `--json` a **published contract**, not a debugging convenience.
 * `skills/_shared/repository-policy.md` documents the payload, and
 * `policy-parity.test.ts` pins the fields the skills read: renaming or dropping
 * one silently makes every skill fall back to its defaults, and nothing would
 * fail — the two paths would simply start deciding differently. Adding a field
 * is safe (readers ignore what they do not know); removing or renaming one
 * bumps `schemaVersion`.
 */

export interface PolicyCommandOptions {
  scope?: string;
  json?: boolean;
}

/** Group the provenance entries by kind, preserving discovery order. */
function groupSources(sources: PolicySource[]): Map<PolicySource['kind'], PolicySource[]> {
  const grouped = new Map<PolicySource['kind'], PolicySource[]>();
  for (const source of sources) {
    const bucket = grouped.get(source.kind);
    if (bucket === undefined) {
      grouped.set(source.kind, [source]);
    } else {
      bucket.push(source);
    }
  }
  return grouped;
}

function describeSource(source: PolicySource): string {
  const where = source.path ?? source.origin;
  const detail = source.detail === null ? '' : ` — ${source.detail}`;
  return `${source.status === 'found' ? '' : `[${source.status}] `}${where}${detail}`;
}

/**
 * Human-readable rendering.
 *
 * Content is deliberately never printed: a resolved policy carries whole
 * `AGENTS.md` and template bodies, and dumping them would bury the one thing
 * this view is for — which file each value came from. `--json` is where the
 * content lives.
 */
function render(policy: RepositoryPolicy): void {
  const lines: string[] = [];
  const push = (line = ''): void => {
    lines.push(line);
  };

  push(`Repository: ${policy.root}`);
  push(`Scope:      ${policy.scope ?? '(root)'}`);
  if (!policy.enabled) {
    push();
    push('Policy discovery is disabled (policy.enabled = false).');
    console.log(lines.join('\n'));
    return;
  }

  push();
  push('Issues');
  push(`  templates: ${policy.issues.templates.length}`);
  for (const template of policy.issues.templates) {
    const labels = template.labels.length > 0 ? ` labels=[${template.labels.join(', ')}]` : '';
    const type = template.type === null ? '' : ` type=${template.type}`;
    push(`    - ${template.path} (${template.format}, ${template.origin})${type}${labels}`);
  }
  push(`  types:  ${policy.issues.types.length > 0 ? policy.issues.types.join(', ') : '(none)'}`);
  push(`  labels: ${policy.issues.labels.length}`);
  for (const label of policy.issues.labels) {
    push(`    - ${label.name}${label.description === null ? '' : ` — ${label.description}`}`);
  }
  push(`  titleConvention: ${policy.issues.titleConvention ?? '(none)'}`);

  push();
  push('Pull Requests');
  push(`  template:  ${policy.pullRequests.templates[0]?.path ?? '(none)'}`);
  for (const template of policy.pullRequests.templates.slice(1)) {
    push(`    - ${template.path}`);
  }
  push(`  baseBranch:      ${policy.pullRequests.baseBranch ?? '(none)'}`);
  push(`  titleConvention: ${policy.pullRequests.titleConvention ?? '(none)'}`);

  push();
  push('Git');
  push(`  branchConvention: ${policy.git.branchConvention ?? '(none)'}`);
  push(`  commitConvention: ${policy.git.commitConvention ?? '(none)'}`);

  push();
  push(`Documents: ${policy.docs.length}`);
  for (const doc of policy.docs) {
    const scope = doc.scope === '' ? 'root' : doc.scope;
    const from = doc.referencedFrom === null ? '' : ` ← ${doc.referencedFrom}`;
    push(`  - ${doc.path} (${doc.kind}, scope=${scope})${from}`);
  }

  push();
  push(`CODEOWNERS: ${policy.codeowners === null ? '(none)' : 'found'}`);

  push();
  push('Sources');
  for (const [kind, entries] of groupSources(policy.sources)) {
    push(`  ${kind}`);
    for (const entry of entries) {
      push(`    - ${describeSource(entry)}`);
    }
  }

  console.log(lines.join('\n'));
}

/**
 * Resolve and print the repository policy. Returns the process exit code.
 *
 * Only a repository that cannot be located at all is a failure: an empty policy
 * is a legitimate — and common — answer, printed like any other.
 */
export async function runPolicy(options: PolicyCommandOptions = {}): Promise<number> {
  let policy: RepositoryPolicy;
  try {
    policy = await loadRepositoryPolicy({ scope: options.scope ?? null });
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (options.json === true) {
    console.log(JSON.stringify(policy, null, 2));
    return 0;
  }

  render(policy);

  const unavailable = policy.sources.filter((source) => source.status === 'unavailable');
  if (unavailable.length > 0) {
    console.log('');
    printWarning(
      `${unavailable.length} source(s) could not be consulted; the policy above is incomplete.`,
    );
  } else if (policy.sources.length === 0) {
    console.log('');
    printInfo('This repository declares no policy sources; Issue Flow defaults apply.');
  }

  return 0;
}
