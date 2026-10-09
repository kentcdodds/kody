import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	assertActorCanRestoreSoftDeletedOrg,
	OrgRestoreWindowExpiredError,
	restoreOrg,
} from '#worker/orgs/soft-delete.ts'

const inputSchema = z.object({
	orgId: z.string().min(1).describe('Soft-deleted organization id to restore.'),
})

const outputSchema = z.object({
	orgId: z.string(),
})

export const orgRestoreCapability = defineDomainCapability(
	capabilityDomainNames.orgs,
	{
		name: 'orgRestore',
		description:
			'Restore a soft-deleted organization within the 30-day retention window. Authorization uses the actor’s Owner membership from the deletion generation because the org cannot be bound while tombstoned.',
		keywords: ['org', 'restore', 'undelete', 'team'],
		// Soft-deleted orgs are not bindable; authorize in the handler.
		orgPermission: 'none',
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				await assertActorCanRestoreSoftDeletedOrg({
					db: ctx.env.APP_DB,
					orgId: args.orgId,
					actorUserId: user.userId,
				})
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === 'org_restore_forbidden'
				) {
					throw new McpCallerError(
						'Only an Owner of the soft-deleted organization can restore it.',
					)
				}
				throw error
			}
			try {
				await restoreOrg({
					env: ctx.env,
					orgId: args.orgId,
					actorUserId: user.userId,
				})
			} catch (error) {
				if (error instanceof OrgRestoreWindowExpiredError) {
					throw new McpCallerError(
						'The 30-day restore window for this organization has expired.',
					)
				}
				throw error
			}
			return { orgId: args.orgId }
		},
	},
)
