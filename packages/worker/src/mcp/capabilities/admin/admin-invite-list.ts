import { z } from 'zod'
import { listInvites } from '#worker/invites.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	adminInviteListedSchema,
	toListedInviteMetadata,
} from './admin-invite-shared.ts'

const outputSchema = z.object({
	invites: z.array(adminInviteListedSchema),
})

export const adminInviteListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminInviteList',
		description:
			'List existing signup invite codes and their use, expiry, and revocation state. Admin-only; returns invite metadata only (no secrets). Newest first, capped at 200.',
		keywords: ['admin', 'invite', 'invites', 'list', 'code', 'signup'],
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminInviteList',
				async () => ({
					invites: (await listInvites(ctx.env.APP_DB)).map(
						toListedInviteMetadata,
					),
				}),
				{
					successReason: ({ invites }) => `count=${invites.length}`,
				},
			)
		},
	},
)
