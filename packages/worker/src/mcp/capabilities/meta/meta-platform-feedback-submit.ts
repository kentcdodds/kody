import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { enqueuePlatformFeedbackDispatch } from '#worker/platform-feedback/dispatch-queue-producer.ts'
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
			'Submit platform feedback only from an interactive MCP agent flow after showing the user the exact proposed summary and details, asking first, and receiving explicit approval. The exact approved summary and details plus the account user id, username, and email may be delivered immediately to deployment admins through admin-configured notification integrations such as Discord. Copies already delivered outside Kody, including Discord messages, may remain after Kody account deletion under the deployment operator’s retention and deletion controls. Non-interactive package code and package apps cannot submit. Do not include secrets or unrelated private content.',
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
					'Must be true only after the agent shows the exact proposed summary and details and the user explicitly approves sending them, with the account user id, username, and email, immediately to deployment admins through admin-configured notification integrations such as Discord, after being told that copies already delivered outside Kody, including Discord messages, may remain after Kody account deletion under the deployment operator’s retention and deletion controls.',
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
				submitterUsername: user.username ?? null,
				submitterEmail: user.email,
				category: args.category,
				summary: args.summary,
				details: args.details,
			})
			try {
				await enqueuePlatformFeedbackDispatch({
					queue: ctx.env.PLATFORM_FEEDBACK_DISPATCH_QUEUE,
					feedbackId: feedback.id,
				})
			} catch (error) {
				console.error('platform-feedback-dispatch-enqueue-failed', error)
			}
			return {
				feedback_id: feedback.id,
				status: 'open' as const,
				created_at: feedback.createdAt,
			}
		},
	},
)
