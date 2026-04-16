import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	deleteMcpSkill,
	getMcpSkillByName,
	insertMcpSkill,
	isDuplicateSkillNameError,
	updateMcpSkill,
} from '#mcp/skills/mcp-skills-repo.ts'
import {
	buildSkillEmbedTextFromStoredRow,
	prepareSkillPersistence,
} from '#mcp/skills/skill-mutation.ts'
import { skillParameterSchema } from '#mcp/skills/skill-parameters.ts'
import { upsertSkillVector } from '#mcp/skills/skill-vectorize.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import { buildSkillSourceFiles } from '#worker/repo/source-templates.ts'
import { requireMcpUser } from './require-user.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { updateEntitySource } from '#worker/repo/entity-sources.ts'

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
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const prep = await prepareSkillPersistence(args)
			const existing = await getMcpSkillByName(
				ctx.env.APP_DB,
				user.userId,
				prep.rowPayload.name,
			)

			const skillId = existing?.id ?? crypto.randomUUID()
			const now = new Date().toISOString()
			const source = await ensureEntitySource({
				db: ctx.env.APP_DB,
				env: ctx.env,
				userId: user.userId,
				entityKind: 'skill',
				entityId: skillId,
				sourceRoot: '/',
			})

			if (existing) {
				const updated = await updateMcpSkill(
					ctx.env.APP_DB,
					user.userId,
					existing.name,
					{
						source_id: source.id,
						...prep.rowPayload,
					},
				)
				if (!updated) {
					throw new Error('Skill not found for this user.')
				}
			} else {
				try {
					await insertMcpSkill(ctx.env.APP_DB, {
						id: skillId,
						user_id: user.userId,
						source_id: source.id,
						...prep.rowPayload,
						created_at: now,
						updated_at: now,
					})
				} catch (error) {
					if (isDuplicateSkillNameError(error)) {
						throw new Error(
							`A saved skill named "${prep.rowPayload.name}" already exists for this user.`,
						)
					}
					throw error
				}
			}

			const syncedPublishedCommit = await syncArtifactSourceSnapshot({
				env: ctx.env,
				userId: user.userId,
				baseUrl: ctx.callerContext.baseUrl,
				sourceId: source.id,
				files: buildSkillSourceFiles({
					title: args.title,
					description: args.description,
					keywords: args.keywords,
					searchText: args.search_text ?? null,
					collection: prep.rowPayload.collection_name,
					readOnly: args.read_only,
					idempotent: args.idempotent,
					destructive: args.destructive,
					usesCapabilities: args.uses_capabilities ?? null,
					parameters: args.parameters ?? null,
					code: args.code,
				}),
			})
			if (syncedPublishedCommit) {
				await updateEntitySource(ctx.env.APP_DB, {
					id: source.id,
					userId: user.userId,
					publishedCommit: syncedPublishedCommit,
					indexedCommit: syncedPublishedCommit,
				})
			}

			try {
				await upsertSkillVector(ctx.env, {
					skillId,
					userId: user.userId,
					embedText: prep.embedText,
					collectionSlug: prep.rowPayload.collection_slug,
				})
			} catch (cause) {
				if (existing) {
					await updateMcpSkill(ctx.env.APP_DB, user.userId, existing.name, {
						source_id: existing.source_id,
						name: existing.name,
						title: existing.title,
						description: existing.description,
						collection_name: existing.collection_name,
						collection_slug: existing.collection_slug,
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
						skillId: existing.id,
						userId: user.userId,
						embedText: oldEmbed,
						collectionSlug: existing.collection_slug,
					})
				} else {
					await deleteMcpSkill(
						ctx.env.APP_DB,
						user.userId,
						prep.rowPayload.name,
					)
				}
				throw cause
			}

			return {
				name: prep.rowPayload.name,
				collection: prep.rowPayload.collection_name,
				collection_slug: prep.rowPayload.collection_slug,
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
