import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcceptanceCheck, AcceptanceContract } from './types.js';

const DISCOVERABLE = ['typecheck', 'lint', 'test'] as const;

async function discoverFromMakefile(cwd: string): Promise<AcceptanceCheck[]> {
  const makePath = join(cwd, 'Makefile');
  if (!existsSync(makePath)) return [];
  let text: string;
  try {
    text = await readFile(makePath, 'utf-8');
  } catch {
    return [];
  }
  const checks: AcceptanceCheck[] = [];
  for (const id of DISCOVERABLE) {
    const pattern = new RegExp(`^${id}\\s*:`, 'm');
    if (pattern.test(text)) {
      checks.push({ id, run: `make ${id}`, fatal: true });
    }
  }
  return checks;
}

async function discoverFromComposer(cwd: string): Promise<AcceptanceCheck[]> {
  const composerPath = join(cwd, 'composer.json');
  if (!existsSync(composerPath)) return [];
  try {
    const raw: unknown = JSON.parse(await readFile(composerPath, 'utf-8'));
    if (!isRecord(raw) || !isRecord(raw.scripts)) return [];
    if (typeof raw.scripts.test === 'string') {
      return [{ id: 'test', run: 'composer test', fatal: true }];
    }
  } catch {
    return [];
  }
  return [];
}

export interface ResolveContractInput {
  cwd: string;
  declared?: AcceptanceCheck[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function resolveContract(input: ResolveContractInput): Promise<AcceptanceContract> {
  if (input.declared !== undefined && input.declared !== null) {
    return { checks: input.declared, source: input.declared.length === 0 ? 'empty' : 'declared' };
  }

  const fromPackage = await discoverFromPackage(input.cwd);
  if (fromPackage.length > 0) return { checks: fromPackage, source: 'discovered' };
  const fromMake = await discoverFromMakefile(input.cwd);
  if (fromMake.length > 0) return { checks: fromMake, source: 'discovered' };
  const fromComposer = await discoverFromComposer(input.cwd);
  if (fromComposer.length > 0) return { checks: fromComposer, source: 'discovered' };
  return { checks: [], source: 'empty' };
}

async function discoverFromPackage(cwd: string): Promise<AcceptanceCheck[]> {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let scripts: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(await readFile(pkgPath, 'utf-8'));
    if (isRecord(raw) && isRecord(raw.scripts)) scripts = raw.scripts;
  } catch {
    return [];
  }

  const checks: AcceptanceCheck[] = [];
  for (const id of DISCOVERABLE) {
    if (typeof scripts[id] === 'string') {
      checks.push({ id, run: id === 'test' ? 'npm test' : `npm run ${id}`, fatal: true });
    }
  }
  return checks;
}
