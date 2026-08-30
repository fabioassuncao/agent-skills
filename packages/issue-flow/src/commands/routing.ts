import { loadRoutingConfig } from '../config.js';
import { loadTaskPlan } from '../core/state-manager.js';
import { decideRouting } from '../routing/decide.js';
import { PRIORS_VERSION } from '../routing/priors.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { printInfo } from '../ui/logger.js';

export const ROUTING_COMMAND_SCHEMA_VERSION = 1;

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
      `sample selected=${sample.selected} actual=${sample.actual} class=${sample.taskClass}`,
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
  const plan = await loadTaskPlan(paths.tasksFile);
  const records = plan.executions ?? [];
  let agree = 0;
  let total = 0;
  for (const record of records) {
    const decision = record.routingDecision;
    if (decision === undefined || decision === null) continue;
    total += 1;
    if (decision.selected === decision.actual) agree += 1;
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
