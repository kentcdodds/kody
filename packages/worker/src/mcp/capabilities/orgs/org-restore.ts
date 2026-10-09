import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { restoreOrg } from '#worker/orgs/soft-delete.ts'

const inputSchema = z.object({
	orgId: z
		.string()
		.min(1)
		.describe('Organization id to restore. Must match the bound request org.'),
})

const outputSchema = z.object({
	orgId: z.string(),
})

export const orgRestoreCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'orgRestore',
		description:
			'Restore a soft-deleted organization within the 30-day retention window.',
		keywords: ['org', 'restore', 'undelete', 'team'],
		orgPermission: 'org:delete',
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			if (args.orgId !== request.org.id) {
				throw new McpCallerError(
					'orgId must match the organization bound to this request.',
				)
			}
			await restoreOrg({
				env: ctx.env,
				orgId: request.org.id,
				actorUserId: user.userId,
			})
			return { orgId: request.org.id }
		},
	},
)
