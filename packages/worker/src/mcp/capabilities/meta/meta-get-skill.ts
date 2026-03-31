import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getMcpSkillByName } from '#mcp/skills/mcp-skills-repo.ts'
import {
	parseSkillParameters,
	skillParameterSchema,
} from '#mcp/skills/skill-parameters.ts'
import { requireMcpUser } from './require-user.ts'

function parseStringArray(raw: string | null): Array<string> | null {
	if (raw == null) return null
	try {
		const v = JSON.parse(raw) as unknown
		if (!Array.isArray(v)) return null
		return v.filter((x): x is string => typeof x === 'string')
	} catch {
		return null
	}
}

const outputSchema = z.object({
	name: z.string(),
	title: z.string(),
	description: z.string(),
	collection: z.string().nullable(),
	collection_slug: z.string().nullable(),
	keywords: z.array(z.string()),
	code: z.string(),
	search_text: z.string().nullable(),
	uses_capabilities: z.array(z.string()).nullable(),
	parameters: z.array(skillParameterSchema).nullable(),
	inferred_capabilities: z.array(z.string()),
	inference_partial: z.boolean(),
	read_only: z.boolean(),
	idempotent: z.boolean(),
	destructive: z.boolean(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const metaGetSkillCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_get_skill',
		description:
			'Load a full saved skill including codemode source (for inspection or pasting into execute).',
		keywords: ['skill', 'get', 'load', 'read'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			name: z.string().min(1).describe('Unique saved skill name.'),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const row = await getMcpSkillByName(
				ctx.env.APP_DB,
				user.userId,
				args.name,
			)
			if (!row) {
				throw new Error('Skill not found for this user.')
			}
			const keywords = parseStringArray(row.keywords) ?? []
			const inferred = parseStringArray(row.inferred_capabilities) ?? []
			const uses = parseStringArray(row.uses_capabilities)
			const parameters = parseSkillParameters(row.parameters)
			return {
				name: row.name,
				title: row.title,
				description: row.description,
				collection: row.collection_name,
				collection_slug: row.collection_slug,
				keywords,
				code: row.code,
				search_text: row.search_text,
				uses_capabilities: uses,
				parameters,
				inferred_capabilities: inferred,
				inference_partial: row.inference_partial === 1,
				read_only: row.read_only === 1,
				idempotent: row.idempotent === 1,
				destructive: row.destructive === 1,
				created_at: row.created_at,
				updated_at: row.updated_at,
			}
		},
	},
)
