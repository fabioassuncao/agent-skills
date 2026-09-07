import { z } from 'zod';
import { printWarning } from '../ui/logger.js';
import { parseBooleanEnv } from './layers.js';
import { updateProjectConfigSection } from './project-settings.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

const linearConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoCreateWorktrees: z.boolean().default(false),
  watchTeams: z.array(z.string().trim().min(1)).default([]),
});

export type LinearConfig = z.infer<typeof linearConfigSchema>;

export interface LoadLinearConfigOptions {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  warn?: (message: string) => void;
}

function parseTeamKeys(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

/** Load non-secret Linear behaviour. The credential is read only by the client. */
export async function loadLinearConfig(
  options: LoadLinearConfigOptions = {},
): Promise<LinearConfig> {
  const warn = options.warn ?? printWarning;
  const env = options.env ?? process.env;
  const project = await readProjectConfigFile(options.projectRoot, warn);
  const raw = project?.linear;
  const fileResult = linearConfigSchema.partial().safeParse(raw ?? {});
  const file = fileResult.success ? fileResult.data : {};
  if (!fileResult.success) {
    warn(
      `Ignoring "linear" key of ${PROJECT_CONFIG_FILENAME}: ${fileResult.error.issues[0]?.message ?? 'invalid value'}.`,
    );
  }
  const watchTeams = parseTeamKeys(env.ISSUE_FLOW_LINEAR_WATCH_TEAMS);
  const merged = {
    ...file,
    ...(env.ISSUE_FLOW_LINEAR_ENABLED === undefined
      ? {}
      : { enabled: parseBooleanEnv(env.ISSUE_FLOW_LINEAR_ENABLED) }),
    ...(env.ISSUE_FLOW_LINEAR_AUTO_CREATE === undefined
      ? {}
      : { autoCreateWorktrees: parseBooleanEnv(env.ISSUE_FLOW_LINEAR_AUTO_CREATE) }),
    ...(watchTeams === undefined ? {} : { watchTeams }),
  };
  const result = linearConfigSchema.safeParse(merged);
  if (result.success) return result.data;
  warn('Invalid Linear configuration; using defaults.');
  return linearConfigSchema.parse({});
}

export async function persistLinearAutoCreate(
  projectRoot: string,
  enabled: boolean,
): Promise<void> {
  await updateProjectConfigSection(projectRoot, 'linear', (linear) => ({
    ...linear,
    autoCreateWorktrees: enabled,
  }));
}

/** Credential access is intentionally separate from configuration persistence. */
export function linearApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.LINEAR_API_KEY?.trim();
  return value ? value : null;
}
