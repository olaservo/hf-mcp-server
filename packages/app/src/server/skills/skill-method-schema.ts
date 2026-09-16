import { z } from 'zod';

export const SKILLS_LIST_METHOD = 'skills/list';
export const SKILLS_GET_METHOD = 'skills/get';

export const SkillsListParamsSchema = z.looseObject({
	cursor: z.string().optional(),
});

export const SkillsGetParamsSchema = z.looseObject({
	uri: z.string(),
});

/** One `{uri, digest, size}` triple of a skill's complete resource manifest. */
export const SkillManifestResourceSchema = z.object({
	uri: z.string(),
	digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
	size: z.number().int().nonnegative(),
});

/** A skill entry as returned by `skills/list` and `skills/get`. */
export const SkillEntrySchema = z.object({
	uri: z.string(),
	frontmatter: z.looseObject({ name: z.string(), description: z.string() }),
	resources: z.array(SkillManifestResourceSchema),
});
