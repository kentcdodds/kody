import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { submitPlatformFeedback } from '#worker/platform-feedback/service.ts'
import { platformFeedbackCategories } from '#worker/platform-feedback/types.ts'
import { requireMcpUser } from './require-user.ts'

const interactiveApprovalErrorMessage =
	'Platform feedback submission is only available from an interactive MCP agent flow after explicit user approval. Non-interactive package code and package apps cannot submit feedback.'

export const metaPlatformFeedbackSubmitCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_platform_feedback_submit',
		description:
			'Submit platform feedback only from an interactive MCP agent flow after asking the user and receiving explicit consent. Non-interactive package code and package apps cannot submit. The submission is attributed to the signed-in user and visible to deployment admins. Do not include secrets or unrelated private content.',
		keywords: [
			'platform feedback',
			'friction',
			'bug report',
			'experience',
			'suggestion',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.strictObject({
			category: z
				.enum(platformFeedbackCategories)
				.describe('Stable feedback category.'),
			summary: z
				.string()
				.trim()
				.min(1)
				.max(200)
				.describe('Concise feedback summary (1–200 characters).'),
			details: z
				.string()
				.trim()
				.min(1)
				.max(8000)
				.describe(
					'Feedback details (1–8000 characters). Do not include secrets or unrelated private content.',
				),
			user_confirmed: z
				.literal(true)
				.describe(
					'Must be true only after the user explicitly confirms this attributed admin-visible submission.',
				),
		}),
		outputSchema: z.object({
			feedback_id: z.string(),
			status: z.literal('open'),
			created_at: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			if (ctx.callerContext.executionOrigin !== 'interactive') {
				throw new Error(interactiveApprovalErrorMessage)
			}
			const packageId =
				ctx.callerContext.storageContext?.packageId?.trim() ?? ''
			if (packageId) {
				throw new Error(interactiveApprovalErrorMessage)
			}
			const feedback = await submitPlatformFeedback({
				db: ctx.env.APP_DB,
				submitterUserId: user.userId,
				category: args.category,
				summary: args.summary,
				details: args.details,
			})
			return {
				feedback_id: feedback.id,
				status: 'open' as const,
				created_at: feedback.createdAt,
			}
		},
	},
)
