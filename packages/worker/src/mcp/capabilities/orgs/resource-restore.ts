import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { restoreResourceRow } from '#worker/orgs/soft-delete.ts'

const inputSchema = z.object({
	orgId: z.string().min(1),
	resourceType: z
		.string()
		.min(1)
		.describe('Resource type key (for example package, secret, email).'),
	resourceId: z.string().min(1),
})

const outputSchema = z.object({
	restored: z.boolean(),
})

export const resourceRestoreCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'resourceRestore',
		description:
			'Restore one soft-deleted org-owned resource row when the org is still within the restore window. Minimal stub for P7; expands with resource-specific permissions later.',
		keywords: ['org', 'restore', 'resource', 'soft delete'],
		orgPermission: 'org:write',
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return await restoreResourceRow({
				env: ctx.env,
				orgId: args.orgId,
				resourceType: args.resourceType,
				resourceId: args.resourceId,
			})
		},
	},
)
