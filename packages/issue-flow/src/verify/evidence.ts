import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getVerificationRepository, saveStoredVerification } from '../storage/db/repository.js';
import { redactSecrets } from '../telemetry/redact.js';
import type { StructuredReview } from './reviewer.js';
import type { ContractRun } from './types.js';

export interface EvidenceBundle {
  executionId: string | null;
  at: string;
  verdict: ContractRun['verdict'];
  level: ContractRun['level'];
  results: ContractRun['results'];
  review?: StructuredReview;
}

export function buildEvidence(
  run: ContractRun,
  executionId: string | null,
  review?: StructuredReview,
): EvidenceBundle {
  return {
    ...(review
      ? {
          review: {
            ...review,
            findings: review.findings.map((finding) => ({
              ...finding,
              ...(finding.file === undefined ? {} : { file: redactSecrets(finding.file) }),
              category: redactSecrets(finding.category),
              claim: redactSecrets(finding.claim),
            })),
          },
        }
      : {}),
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
