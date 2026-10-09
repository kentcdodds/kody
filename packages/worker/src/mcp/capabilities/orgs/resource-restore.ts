import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { restoreResourceRow } from '#worker/orgs/soft-delete.ts'

const inputSchema = z.object({
	orgId: z
		.string()
		.min(1)
		.describe('Organization id. Must match the bound request org.'),
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
			const request = requireMcpRequest(ctx.callerContext)
			if (args.orgId !== request.org.id) {
				throw new McpCallerError(
					'orgId must match the organization bound to this request.',
				)
			}
			return await restoreResourceRow({
				env: ctx.env,
				orgId: request.org.id,
				resourceType: args.resourceType,
				resourceId: args.resourceId,
			})
		},
	},
)
