import { z } from 'zod'
import { followCommunityUser } from '#worker/community/social-service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const communityFollowCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_follow',
		description:
			'Follow a public community user so their public listing activity appears in your timeline. Re-following is a no-op.',
		keywords: ['community', 'follow', 'follower', 'social', 'timeline'],
		tags: ['community', 'follow'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			username: z
				.string()
				.min(1)
				.describe('Username of the public profile to follow.'),
		}),
		outputSchema: z.object({
			following: z.literal(true),
			username: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			await followCommunityUser({
				env: ctx.env,
				followerUserId: user.userId,
				followeeUsername: args.username,
			})
			return {
				following: true as const,
				username: args.username,
			}
		},
	},
)
