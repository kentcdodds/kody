import { z } from 'zod'
import { findStableUserIdConflictByEmail } from '#worker/admin/users-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z.object({
	email: z
		.string()
		.email()
		.describe(
			'Email that a legacy account may still reserve because its stable_user_id is sha256 of that email.',
		),
})

const conflictSchema = z.object({
	stableUserId: stableUserIdSchema,
	username: z.string(),
	created_at: z.string(),
	email_verified: z.boolean(),
})

const outputSchema = z.object({
	conflict: conflictSchema.nullable(),
})

export const adminUserStableIdConflictCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminUserStableIdConflict',
		description:
			'Report whether a legacy account (created before random stable ids) still reserves an email because its stable_user_id is sha256 of that email while its current email differs. New accounts get random ids and never collide. Admin-only metadata; never returns user content.',
		keywords: [
			'admin',
			'user',
			'stable user id',
			'email',
			'collision',
			'signup',
			'squat',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserStableIdConflict',
				async () => {
					const conflict = await findStableUserIdConflictByEmail(
						ctx.env.APP_DB,
						args.email,
					)
					return { conflict }
				},
				{
					successReason: ({ conflict }) =>
						conflict
							? `stable_user_id_conflict;target_stable_user_id=${conflict.stableUserId}`
							: 'stable_user_id_conflict_none',
				},
			)
		},
	},
)
