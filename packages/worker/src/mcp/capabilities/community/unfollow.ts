import { z } from 'zod'
import { unfollowCommunityUser } from '#worker/community/social-service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const communityUnfollowCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_unfollow',
		description:
			'Stop following a community user. Unfollowing when not following or when the username is unknown is a no-op.',
		keywords: ['community', 'unfollow', 'follower', 'social', 'timeline'],
		tags: ['community', 'follow'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			username: z
				.string()
				.min(1)
				.describe('Username of the profile to unfollow.'),
		}),
		outputSchema: z.object({
			following: z.literal(false),
			username: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			await unfollowCommunityUser({
				env: ctx.env,
				followerUserId: user.userId,
				followeeUsername: args.username,
			})
			return {
				following: false as const,
				username: args.username,
			}
		},
	},
)
