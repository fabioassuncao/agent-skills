import { z } from 'zod';
import {
  AUTO_NAME_MAX_LENGTH,
  AUTO_NAME_TIMEOUT_MS,
  type AutoNameBranchOptions,
} from '../conventions/git/auto-name.js';
import { printWarning } from '../ui/logger.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

const autoNameConfigSchema = z.union([
  z.boolean(),
  z.object({
    maxLength: z.number().int().positive().default(AUTO_NAME_MAX_LENGTH),
    timeoutMs: z.number().int().positive().default(AUTO_NAME_TIMEOUT_MS),
    systemPrompt: z.string().optional(),
  }),
]);

/** Effective provider-neutral auto-name policy; absent/false means disabled. */
export async function loadAutoNameConfig(
  options: { projectRoot?: string; warn?: (message: string) => void } = {},
): Promise<AutoNameBranchOptions | null> {
  const warn = options.warn ?? printWarning;
  const project = await readProjectConfigFile(options.projectRoot, warn);
  if (project?.autoName === undefined || project.autoName === null) return null;
  const parsed = autoNameConfigSchema.safeParse(project.autoName);
  if (!parsed.success) {
    warn(`Ignoring "autoName" key of ${PROJECT_CONFIG_FILENAME}: invalid value.`);
    return null;
  }
  if (parsed.data === false) return null;
  if (parsed.data === true) {
    return { maxLength: AUTO_NAME_MAX_LENGTH, timeoutMs: AUTO_NAME_TIMEOUT_MS };
  }
  return parsed.data;
}
