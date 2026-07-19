import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { isPlatformFeedbackDomainError } from '#worker/platform-feedback/errors.ts'
import { updatePlatformFeedbackForAdmin } from '#worker/platform-feedback/service.ts'
import { platformFeedbackActions } from '#worker/platform-feedback/types.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	adminPlatformFeedbackRecordSchema,
	formatAdminPlatformFeedbackRecord,
} from './platform-feedback-shared.ts'

const inputSchema = z.object({
	id: z.string().min(1).describe('Platform feedback id to update.'),
	action: z
		.enum(platformFeedbackActions)
		.describe(
			'Triage open feedback, resolve open/triaged feedback, or dismiss open/triaged feedback.',
		),
	admin_note: z
		.string()
		.trim()
		.max(2000)
		.optional()
		.describe('Optional deployment-admin note (at most 2000 characters).'),
})

const outputSchema = z.object({
	feedback: adminPlatformFeedbackRecordSchema,
})

export const adminPlatformFeedbackUpdateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_platform_feedback_update',
		description:
			'Triage, resolve, or dismiss one platform feedback record using its allowed status transition. Admin-only; records reviewer attribution and an optional admin note.',
		keywords: ['admin', 'platform feedback', 'triage', 'resolve', 'dismiss'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_platform_feedback_update',
				async () => {
					try {
						const feedback = await updatePlatformFeedbackForAdmin({
							db: ctx.env.APP_DB,
							feedbackId: args.id,
							reviewerUserId: user.userId,
							action: args.action,
							adminNote: args.admin_note,
						})
						return { feedback: formatAdminPlatformFeedbackRecord(feedback) }
					} catch (error) {
						if (isPlatformFeedbackDomainError(error)) {
							throw new Error(error.message)
						}
						throw error
					}
				},
				{
					successReason: ({ feedback }) =>
						`feedback_id=${feedback.id};status=${feedback.status}`,
				},
			)
		},
	},
)
