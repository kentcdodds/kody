import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { insertMcpSkill, deleteMcpSkill } from '#mcp/skills/mcp-skills-repo.ts'
import { prepareSkillPersistence } from '#mcp/skills/skill-mutation.ts'
import { skillParameterSchema } from '#mcp/skills/skill-parameters.ts'
import { upsertSkillVector } from '#mcp/skills/skill-vectorize.ts'
import { requireMcpUser } from './require-user.ts'

const inputSchema = z.object({
	title: z.string().min(1).describe('Short title for the skill.'),
	description: z
		.string()
		.min(1)
		.describe('What this skill does (shown in search and to users).'),
	keywords: z
		.array(z.string())
		.describe('Extra search keywords for this skill.'),
	code: z
		.string()
		.min(1)
		.describe(
			'Codemode snippet as accepted by execute (async arrow or equivalent after normalization).',
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
		.array(skillParameterSchema)
		.optional()
		.describe(
			'Optional parameter definitions (names/types/defaults) for running this skill with inputs.',
		),
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
	skill_id: z.string(),
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
			'Save a reusable codemode skill for the signed-in user when the workflow is reasonably repeatable (a pattern you expect to run again with similar structure or inputs). Do not save one-off tasks or highly bespoke work—use execute for those. To change an existing skill in place, use meta_update_skill instead.',
		keywords: ['skill', 'save', 'codemode', 'recipe', 'reuse', 'persist'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const prep = await prepareSkillPersistence(args)

			const skillId = crypto.randomUUID()
			const now = new Date().toISOString()
			await insertMcpSkill(ctx.env.APP_DB, {
				id: skillId,
				user_id: user.userId,
				...prep.rowPayload,
				created_at: now,
				updated_at: now,
			})

			try {
				await upsertSkillVector(ctx.env, {
					skillId,
					userId: user.userId,
					embedText: prep.embedText,
				})
			} catch (cause) {
				await deleteMcpSkill(ctx.env.APP_DB, user.userId, skillId)
				throw cause
			}

			return {
				skill_id: skillId,
				inferred_capabilities: prep.merged,
				inference_partial: prep.inferencePartial,
				destructive_derived: prep.derived.destructiveDerived,
				read_only_derived: prep.derived.readOnlyDerived,
				idempotent_derived: prep.derived.idempotentDerived,
				...(prep.warnings.length > 0 ? { warnings: prep.warnings } : {}),
			}
		},
	},
)
