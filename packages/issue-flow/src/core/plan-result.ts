import { z } from 'zod';
import { parseDocumentResult } from './document-result.js';

const storyDraftSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string().min(1)).optional().default([]),
});

const planDraftSchema = z.object({
  description: z.string().min(1),
  stories: z.array(storyDraftSchema).min(1),
});

export type PlanDraft = z.infer<typeof planDraftSchema>;

/** Parse semantic planning output; lifecycle fields remain CLI-owned. */
export function parsePlanResult(output: string): PlanDraft {
  const content = parseDocumentResult(output, 'task-plan');
  const draft = planDraftSchema.parse(JSON.parse(content));
  const keys = new Set<string>();
  for (const story of draft.stories) {
    if (keys.has(story.key)) throw new Error(`Duplicate story key: ${story.key}`);
    keys.add(story.key);
  }
  for (const story of draft.stories) {
    for (const dependency of story.dependsOn) {
      if (dependency === story.key) throw new Error(`Story ${story.key} depends on itself`);
      if (!keys.has(dependency))
        throw new Error(`Story ${story.key} has unknown dependency ${dependency}`);
    }
  }
  return draft;
}
