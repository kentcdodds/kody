import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listFollowsForOrg } from '#worker/follow/service.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { followViewSchema } from './shared.ts'

export const followListCapability = defineDomainCapability(
	capabilityDomainNames.follow,
	{
		name: 'followList',
		orgPermission: 'org:read',
		description:
			'List follows owned by the org this connection is bound to. Each row is named by @handle/name. Status is active or paused. Paused follows stop receiving events until followAdd resumes them. This list never includes internal ids.',
		keywords: [
			'follow',
			'follow_repo',
			'followList',
			'watch',
			'list follows',
			'follow.published',
			'follow.pushed',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			follows: z.array(followViewSchema),
		}),
		async handler(_args, ctx) {
			requireMcpUser(ctx.callerContext)
			const follows = await listFollowsForOrg({
				db: ctx.env.APP_DB,
				followerOrgId: ownerIdFromCaller(ctx.callerContext),
			})
			return { follows }
		},
	},
)
