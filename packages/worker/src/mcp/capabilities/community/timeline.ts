import { z } from 'zod'
import { getCommunityTimeline } from '#worker/community/social-service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { callerContextFields } from '#mcp/observability.ts'
import {
	communityActivityItemSchema,
	toCommunityActivityItemOutput,
} from './shared.ts'

export const communityTimelineCapability = defineDomainCapability(
	capabilityDomainNames.community,
	{
		name: 'community_timeline',
		description:
			'List recent public community activity from users you follow, newest first. Includes publishes, updates, forks, and stars from public profiles.',
		keywords: ['community', 'timeline', 'feed', 'follow', 'activity', 'social'],
		tags: ['community', 'timeline'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.default(30)
				.describe('Maximum activity items to return (default 30, max 100).'),
		}),
		outputSchema: z.object({
			items: z.array(communityActivityItemSchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { baseUrl } = callerContextFields(ctx.callerContext)
			const items = await getCommunityTimeline({
				env: ctx.env,
				userId: user.userId,
				limit: args.limit ?? 30,
			})
			return {
				items: items.map((item) =>
					toCommunityActivityItemOutput(item, baseUrl),
				),
			}
		},
	},
)
