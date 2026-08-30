import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getVerificationRepository, saveStoredVerification } from '../storage/db/repository.js';
import { redactSecrets } from '../telemetry/redact.js';
import type { ContractRun } from './types.js';

export interface EvidenceBundle {
  executionId: string | null;
  at: string;
  verdict: ContractRun['verdict'];
  level: ContractRun['level'];
  results: ContractRun['results'];
}

export function buildEvidence(run: ContractRun, executionId: string | null): EvidenceBundle {
  return {
    executionId,
    at: new Date().toISOString(),
    verdict: run.verdict,
    level: run.level,
    results: run.results.map((result) => ({
      ...result,
      output: redactSecrets(result.output),
    })),
  };
}

export async function writeEvidence(path: string, bundle: EvidenceBundle): Promise<void> {
  const repository = getVerificationRepository(path);
  if (repository !== undefined) {
    await saveStoredVerification(repository, bundle as unknown as Record<string, unknown>);
  }
  // Keep the existing evidence file as a human-readable compatibility projection.
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
}
