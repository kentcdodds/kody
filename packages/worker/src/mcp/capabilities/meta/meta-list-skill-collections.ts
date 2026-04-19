import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'

const collectionSummarySchema = z.object({
	name: z.string(),
	slug: z.string(),
	skill_count: z.number().int().nonnegative(),
})

const outputSchema = z.object({
	total: z.number().int().nonnegative(),
	collections: z.array(collectionSummarySchema),
})

export const metaListSkillCollectionsCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_list_skill_collections',
		description:
			'List the signed-in user’s saved skill collections with normalized slugs and skill counts. Use this to browse or confirm available skill groupings before filtering search or saving a new skill.',
		keywords: ['skill', 'collections', 'domains', 'groups', 'browse', 'list'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			void ctx
			return {
				total: 0,
				collections: [],
			}
		},
	},
)
