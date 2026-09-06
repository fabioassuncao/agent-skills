import { join } from 'node:path';
import { resolveAgentFor } from '../agents/resolve.js';
import type { AgentProviderId } from '../agents/types.js';
import { loadVerifyConfig } from '../config.js';
import { getSessionPublisher } from '../core/session-publisher.js';
import { isoNow } from '../core/state-manager.js';
import { PRD_FILENAME, TASKS_FILENAME, VERIFY_FILENAME } from '../storage/paths.js';
import { attachVerdict } from '../telemetry/recorder.js';
import { getHeadCommit, getProjectRoot } from '../utils/git.js';
import { run } from '../utils/shell.js';
import { resolveContract } from './contract.js';
import { buildEvidence, writeEvidence } from './evidence.js';
import { decideLevel } from './level.js';
import { buildReviewContext, runIndependentReview, type StructuredReview } from './reviewer.js';
import { runContract } from './runner.js';
import type { AcceptanceCheck, ContractRun, VerdictStatus, VerificationLevel } from './types.js';

export interface AcceptanceOutcome {
  contract: ContractRun;
  level: VerificationLevel;
  verdict: VerdictStatus;
  review: StructuredReview | null;
}

/**
 * Split a contract command into file and argv, honouring quotes.
 *
 * Commands run without a shell, so a naive split on whitespace turns
 * `pytest -k "not slow"` into three broken arguments and the check fails for a
 * reason that has nothing to do with the code under test. A discovered command
 * is always simple; a declared one is whatever the repository wrote.
 */
export function splitCommand(command: string): [string, string[]] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let pending = false;

  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      pending = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== '' || pending) parts.push(current);
      current = '';
      pending = false;
      continue;
    }
    current += char;
  }
  if (current !== '' || pending) parts.push(current);

  return [parts[0] ?? command, parts.slice(1)];
}

export async function runAcceptance(options: {
  cwd?: string;
  issueDir: string;
  executionId?: string | null;
  declared?: AcceptanceCheck[] | null;
  producer?: AgentProviderId;
  addDirs?: string[];
  signals?: readonly string[];
  explicit?: boolean;
  skipReviewer?: boolean;
}): Promise<AcceptanceOutcome> {
  const cwd = options.cwd ?? (await getProjectRoot());
  const verify = await loadVerifyConfig({ projectRoot: cwd });
  const level = decideLevel({
    requested: verify.level,
    triggers: verify.triggers,
    signals: options.signals ?? [],
    explicit: options.explicit,
    crossVerify: verify.crossVerify,
  });

  const contract = await resolveContract({
    cwd,
    declared: options.declared !== undefined ? options.declared : verify.contract,
  });
  const executed = await runContract(contract, {
    cwd,
    run: async (command, directory) => {
      const [file, args] = splitCommand(command);
      return run(file, args, { cwd: directory });
    },
  });
  executed.level = level === 'L0' ? 'L0' : 'L1';

  // Written before the reviewer, so a crash there still leaves the L1 evidence
  // on disk, and rewritten after it, so the artifact records the verdict the
  // pipeline actually acted on rather than the L1 run it superseded.
  const evidencePath = join(options.issueDir, VERIFY_FILENAME);
  await writeEvidence(evidencePath, buildEvidence(executed, options.executionId ?? null));

  let review: StructuredReview | null = null;
  let verdict: VerdictStatus = executed.verdict;

  if (level === 'L2' && options.skipReviewer !== true && executed.verdict !== 'failed') {
    const producer = options.producer ?? (await resolveAgentFor('execute')).provider;
    review = await runIndependentReview({
      producer,
      pairings: verify.pairings,
      addDirs: options.addDirs,
      promptContext: buildReviewContext({
        cwd,
        head: await getHeadCommit(cwd),
        tasksPath: join(options.issueDir, TASKS_FILENAME),
        prdPath: join(options.issueDir, PRD_FILENAME),
        evidencePath,
        contract: executed,
      }),
    });
    if (review.status === 'failed') verdict = 'failed';
    else if (review.status === 'unverified' && verdict === 'passed') verdict = 'unverified';

    await writeEvidence(
      evidencePath,
      buildEvidence({ ...executed, level: 'L2', verdict }, options.executionId ?? null, review),
    );
  }

  await attachVerdict({
    status: verdict,
    level,
    independence: review?.independence ?? null,
  });

  getSessionPublisher().publish({
    type: 'verify:end',
    at: isoNow(),
    verdict,
    level,
    independence: review?.independence ?? null,
    executionId: options.executionId ?? null,
  });

  return { contract: executed, level, verdict, review };
}
