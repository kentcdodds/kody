import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'

const inputSchema = z.object({
	name: z
		.string()
		.min(1)
		.describe(
			'Unique lower-kebab-case skill name for this user. This is the public way to refer to the skill in search, get, run, update, and delete flows.',
		),
	title: z.string().min(1).describe('Short title for the skill.'),
	description: z
		.string()
		.min(1)
		.describe('What this skill does (shown in search and to users).'),
	collection: z
		.string()
		.optional()
		.describe(
			'Optional user-defined collection/domain label for grouping related saved skills.',
		),
	keywords: z
		.array(z.string())
		.describe('Extra search keywords for this skill.'),
	code: z
		.string()
		.min(1)
		.describe(
			'Module source for the saved skill entrypoint. It must default export a function so Kody can invoke it with execute semantics.',
		),
	search_text: z
		.string()
		.optional()
		.describe(
			'Optional retrieval-only text (not necessarily user-visible) to improve search recall.',
		),
	uses_capabilities: z
		.array(z.string())
		.optional()
		.describe(
			'Explicit capability names to merge with static inference (for dynamic codemode[variable] access).',
		),
	parameters: z
		.array(z.unknown())
		.optional()
		.describe('Legacy skill parameters input.'),
	read_only: z
		.boolean()
		.describe(
			'Whether this skill is read-only (validated against inferred caps).',
		),
	idempotent: z
		.boolean()
		.describe(
			'Whether the skill is idempotent (heuristic validation when inference is trusted).',
		),
	destructive: z
		.boolean()
		.describe(
			'Whether the skill performs destructive operations (validated against inferred caps).',
		),
})

const outputSchema = z.object({
	name: z.string(),
	collection: z.string().nullable(),
	collection_slug: z.string().nullable(),
	inferred_capabilities: z.array(z.string()),
	inference_partial: z.boolean(),
	destructive_derived: z.boolean(),
	read_only_derived: z.boolean().nullable(),
	idempotent_derived: z.boolean().nullable(),
	warnings: z.array(z.string()).optional(),
})

export const metaSaveSkillCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_save_skill',
		description:
			'Save or replace a reusable codemode skill for the signed-in user by name when the workflow is reasonably repeatable (a pattern you expect to run again with similar structure or inputs). The lower-kebab-case skill name is the public identifier, so calling this again with the same name replaces the stored skill in place. Do not save one-off tasks or highly bespoke work—use execute for those.',
		keywords: [
			'skill',
			'save',
			'codemode',
			'recipe',
			'reuse',
			'persist',
			'collection',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler() {
			throw new Error(
				'Saving skills directly is no longer supported. Save an app with tasks instead.',
			)
		},
	},
)
