import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getMcpSkillById, updateMcpSkill } from '#mcp/skills/mcp-skills-repo.ts'
import {
	buildSkillEmbedTextFromStoredRow,
	prepareSkillPersistence,
} from '#mcp/skills/skill-mutation.ts'
import { skillParameterSchema } from '#mcp/skills/skill-parameters.ts'
import { upsertSkillVector } from '#mcp/skills/skill-vectorize.ts'
import { requireMcpUser } from './require-user.ts'

const inputSchema = z.object({
	skill_id: z
		.string()
		.min(1)
		.describe('Existing skill id (same as returned by meta_save_skill).'),
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
			'Replacement codemode snippet as accepted by execute (async arrow or equivalent after normalization).',
		),
	search_text: z.string().optional(),
	uses_capabilities: z.array(z.string()).optional(),
	parameters: z
		.array(skillParameterSchema)
		.optional()
		.describe('Replacement parameter definitions for the skill.'),
	read_only: z.boolean(),
	idempotent: z.boolean(),
	destructive: z.boolean(),
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

export const metaUpdateSkillCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_update_skill',
		description:
			'Replace fields and codemode for an existing skill (same skill_id). Re-runs inference, validation, D1 update, and Vectorize upsert. Use when meta_run_skill fails due to bad stored code.',
		keywords: ['skill', 'update', 'edit', 'replace', 'fix', 'codemode'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const existing = await getMcpSkillById(
				ctx.env.APP_DB,
				user.userId,
				args.skill_id,
			)
			if (!existing) {
				throw new Error('Skill not found for this user.')
			}

			const { skill_id, ...rest } = args
			const prep = await prepareSkillPersistence(rest)

			const updated = await updateMcpSkill(
				ctx.env.APP_DB,
				user.userId,
				skill_id,
				prep.rowPayload,
			)
			if (!updated) {
				throw new Error('Skill not found for this user.')
			}

			try {
				await upsertSkillVector(ctx.env, {
					skillId: skill_id,
					userId: user.userId,
					embedText: prep.embedText,
				})
			} catch (cause) {
				await updateMcpSkill(ctx.env.APP_DB, user.userId, skill_id, {
					title: existing.title,
					description: existing.description,
					keywords: existing.keywords,
					code: existing.code,
					search_text: existing.search_text,
					uses_capabilities: existing.uses_capabilities,
				parameters: existing.parameters,
					inferred_capabilities: existing.inferred_capabilities,
					inference_partial: existing.inference_partial,
					read_only: existing.read_only,
					idempotent: existing.idempotent,
					destructive: existing.destructive,
				})
				const oldEmbed = await buildSkillEmbedTextFromStoredRow(existing)
				await upsertSkillVector(ctx.env, {
					skillId: skill_id,
					userId: user.userId,
					embedText: oldEmbed,
				})
				throw cause
			}

			return {
				skill_id,
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
