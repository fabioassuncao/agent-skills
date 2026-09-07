import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { probeReadinessInventory } from '../agents/availability.js';
import { AGENT_PHASES } from '../agents/types.js';
import { GLOBAL_CONFIG_FILENAME, loadRoutingConfig } from '../config.js';
import { decideRouting } from '../routing/decide.js';
import { MODEL_CATALOG_VERSION } from '../routing/models.js';
import { RECOMMENDED_POLICY_VERSION } from '../routing/policy.js';
import { PRIORS_VERSION } from '../routing/priors.js';
import { type RoutingConfigInput, routingConfigInputSchema } from '../schemas.js';
import { getPlanRepository, listStoredExecutions } from '../storage/db/repository.js';
import { getGlobalRoot } from '../storage/paths.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { printError, printInfo, printSuccess } from '../ui/logger.js';
import { writeFileAtomic } from '../utils/fs.js';
import { getProjectRoot } from '../utils/git.js';

export const ROUTING_COMMAND_SCHEMA_VERSION = 1;

function targetLabel(
  target:
    | { harness: string; provider: string; model?: string | null; tier?: string }
    | string
    | undefined,
): string {
  if (target === undefined) return '—';
  if (typeof target === 'string') return target;
  const tier = target.tier ? `:${target.tier}` : '';
  const model = target.model ? ` · ${target.model}` : '';
  return `${target.provider}${tier}${model}`;
}

function targetKey(
  target:
    | { harness: string; provider: string; model?: string | null; tier?: string }
    | string
    | undefined,
): string {
  if (target === undefined) return '—';
  if (typeof target === 'string') return target;
  return `${target.harness}:${target.provider}:${target.model ?? ''}`;
}

export async function runRoutingInspect(options: { json?: boolean }): Promise<number> {
  const config = await loadRoutingConfig();
  const sample = decideRouting({
    phase: 'execute',
    actualHarness: 'claude-code',
    mode: config.mode,
    profile: config.profile,
  });
  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: ROUTING_COMMAND_SCHEMA_VERSION,
          priorsVersion: PRIORS_VERSION,
          modelCatalogVersion: MODEL_CATALOG_VERSION,
          recommendedPolicyVersion: RECOMMENDED_POLICY_VERSION,
          config,
          sample,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  printInfo(`routing.mode: ${config.mode} (default shadow — records, does not act)`);
  printInfo(`routing.profile: ${config.profile}`);
  if (sample) {
    printInfo(
      `sample selected=${targetLabel(sample.selected)} actual=${targetLabel(sample.actual)} class=${sample.taskClass}`,
    );
  }
  return 0;
}

export async function runRoutingReport(options: {
  issue?: string;
  json?: boolean;
}): Promise<number> {
  if (options.issue === undefined) {
    printInfo('Pass --issue N to compare selected vs actual on that plan.');
    return 0;
  }
  const paths = await resolveIssuePaths(options.issue);
  const repository = getPlanRepository(paths.tasksFile);
  if (repository === undefined) {
    printError('SQLite repository is not registered for this issue.');
    return 1;
  }
  const records = await listStoredExecutions({
    projectId: repository.projectId,
    issueId: repository.issueId,
    databaseOptions: repository.databaseOptions,
  });
  let agree = 0;
  let total = 0;
  for (const record of records) {
    const decision = record.routingDecision;
    if (decision === undefined || decision === null) continue;
    total += 1;
    if (targetKey(decision.selected) === targetKey(decision.actual)) agree += 1;
  }
  const rate = total === 0 ? 0 : agree / total;
  if (options.json === true) {
    console.log(
      JSON.stringify({ schemaVersion: ROUTING_COMMAND_SCHEMA_VERSION, total, agree, rate }),
    );
    return 0;
  }
  printInfo(`shadow agreement: ${agree}/${total} (${(rate * 100).toFixed(0)}%)`);
  return 0;
}

export async function runRoutingExplain(options: { json?: boolean } = {}): Promise<number> {
  const config = await loadRoutingConfig();
  const inventory = await probeReadinessInventory();
  const phases = AGENT_PHASES.map((phase) => {
    const decision = decideRouting({
      phase,
      actualHarness: 'claude-code',
      actualProvider: 'claude',
      mode: config.mode === 'off' ? 'shadow' : config.mode,
      profile: config.profile,
      policy: config.policy,
      readiness: inventory,
    });
    const ranking = (decision?.candidates ?? [])
      .filter((candidate) => candidate.eligible)
      .slice(0, 5)
      .map((candidate) => ({
        harness: candidate.harness,
        provider: candidate.provider,
        model: candidate.model,
        tier: candidate.tier,
        score: candidate.score,
        reasonCodes: candidate.reasonCodes,
      }));
    return {
      phase,
      target: decision?.selected ?? null,
      origin: config.policy === 'recommended' ? 'recommended policy' : 'adaptive score',
      reasonCodes: decision?.reasonCodes ?? [],
      ranking,
    };
  });
  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: ROUTING_COMMAND_SCHEMA_VERSION,
          config,
          inventory,
          phases,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  printInfo(`routing policy: ${config.policy ?? 'adaptive'} (${config.mode})`);
  printInfo('inventory');
  for (const provider of Object.values(inventory.providers)) {
    printInfo(
      `  ${provider.provider.padEnd(12)} ${provider.state.padEnd(12)} auth=${provider.authentication} · ${provider.detail}`,
    );
  }
  for (const phase of phases) {
    printInfo(
      `${phase.phase.padEnd(12)} ${targetLabel(phase.target ?? undefined)} (${phase.origin})`,
    );
  }
  return 0;
}

export async function writeRoutingPreference(input: {
  target: 'global' | 'project';
  values: RoutingConfigInput;
  projectRoot?: string;
}): Promise<string> {
  const parsed = routingConfigInputSchema.safeParse(input.values);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    throw new Error(
      parsed.success
        ? 'At least one routing setting is required.'
        : `Invalid routing setting: ${parsed.error.issues[0]?.message ?? 'invalid value'}.`,
    );
  }
  const path =
    input.target === 'global'
      ? join(getGlobalRoot(), GLOBAL_CONFIG_FILENAME)
      : join(input.projectRoot ?? (await getProjectRoot()), '.issue-flow.json');
  let existing: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf-8'));
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      existing = value as Record<string, unknown>;
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Could not read ${path}: ${(error as Error).message}`);
    }
  }
  const current =
    existing.routing !== null &&
    typeof existing.routing === 'object' &&
    !Array.isArray(existing.routing)
      ? (existing.routing as Record<string, unknown>)
      : {};
  existing.routing = { ...current, ...parsed.data };
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(existing, null, 2)}\n`);
  return path;
}

export async function runRoutingUse(
  policy: string,
  options: { active?: boolean; global?: boolean; project?: boolean } = {},
): Promise<number> {
  if (policy !== 'recommended') {
    printError(`Unknown routing policy '${policy}'. Valid policy: recommended.`);
    return 1;
  }
  try {
    const file = await writeRoutingPreference({
      target: options.project === true ? 'project' : 'global',
      values: {
        policy: 'recommended',
        ...(options.active === true ? { mode: 'active' as const } : {}),
      },
    });
    printSuccess(
      `Wrote recommended routing policy${options.active === true ? ' in active mode' : ''} to ${file}`,
    );
    return 0;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
