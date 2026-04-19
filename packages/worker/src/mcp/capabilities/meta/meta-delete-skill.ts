import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'

const outputSchema = z.object({
	deleted: z.boolean(),
})

export const metaDeleteSkillCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_delete_skill',
		description:
			'Legacy capability removed by the app-model cutover. Tasks now belong to apps and must be managed through app APIs.',
		keywords: ['skill', 'delete', 'remove'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			name: z.string().min(1).describe('Unique lower-kebab-case skill name.'),
		}),
		outputSchema,
		async handler() {
			throw new Error(
				'meta_delete_skill has been removed. Tasks now belong to apps; edit the containing app and remove the task there.',
			)
		},
	},
)
