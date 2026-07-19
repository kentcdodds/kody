import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { getPlatformFeedbackForAdmin } from '#worker/platform-feedback/service.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	adminPlatformFeedbackRecordSchema,
	formatAdminPlatformFeedbackRecord,
} from './platform-feedback-shared.ts'

const inputSchema = z.object({
	id: z.string().min(1).describe('Platform feedback id to read.'),
})

const outputSchema = z.object({
	feedback: adminPlatformFeedbackRecordSchema.nullable(),
})

export const adminPlatformFeedbackGetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_platform_feedback_get',
		description:
			'Read one full attributed platform feedback record explicitly submitted for deployment-admin review. Admin-only.',
		keywords: ['admin', 'platform feedback', 'details', 'review'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_platform_feedback_get',
				async () => {
					const feedback = await getPlatformFeedbackForAdmin({
						db: ctx.env.APP_DB,
						feedbackId: args.id,
					})
					return {
						feedback: feedback
							? formatAdminPlatformFeedbackRecord(feedback)
							: null,
					}
				},
				{
					successReason: ({ feedback }) =>
						feedback
							? `feedback_id=${feedback.id}`
							: `feedback_id=${args.id};not_found`,
				},
			)
		},
	},
)
