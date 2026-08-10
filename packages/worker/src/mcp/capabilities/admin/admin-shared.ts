import { z } from 'zod'
import {
	auditDatabaseFromEnv,
	logAuditEvent,
	redactEmailRecipient,
} from '#worker/audit-log.ts'
import { roleNames } from '#universal/permissions.ts'
import { planNames } from '#universal/plans.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'

export const adminCapabilityAccess = {
	requiredRole: 'admin',
	readOnly: true,
	idempotent: true,
	destructive: false,
} as const

export const adminMutationCapabilityAccess = {
	requiredRole: 'admin',
	readOnly: false,
	idempotent: false,
	destructive: false,
} as const

export const roleNameSchema = z.enum(roleNames)

export const planNameSchema = z.enum(planNames)

export const stableUserIdSchema = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.describe('Stable users.stable_user_id.')

export const adminUserMetadataSchema = z.object({
	stableUserId: stableUserIdSchema,
	username: z.string(),
	email: z.string(),
	email_verified: z
		.boolean()
		.describe('True when email_verified_at is non-null.'),
	email_verified_at: z
		.string()
		.nullable()
		.describe('Raw users.email_verified_at timestamp, or null if unverified.'),
	plan: planNameSchema.describe(
		'Entitlement plan name. Unknown or unexpected NULL stored values resolve to max.',
	),
	suspended_at: z
		.string()
		.nullable()
		.describe(
			'Set when the account is platform-suspended (blocked at session, MCP, and email chokepoints).',
		),
	email_outbound_paused_at: z
		.string()
		.nullable()
		.describe(
			'Set when outbound email was automatically paused after spam complaints or repeated bounces.',
		),
	created_at: z.string(),
	updated_at: z.string(),
	roles: z.array(roleNameSchema),
})

function getErrorReason(error: unknown) {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message.slice(0, 240)
	}
	return 'unknown_error'
}

export async function auditAdminCapabilityInvocation<TResult>(
	ctx: CapabilityContext,
	capabilityName: string,
	run: () => Promise<TResult>,
	options: {
		successReason?: (result: TResult) => string
	} = {},
): Promise<TResult> {
	const actorEmail = ctx.callerContext.user?.email
	try {
		const result = await run()
		await logAuditEvent({
			db: auditDatabaseFromEnv(ctx.env),
			category: 'admin',
			action: capabilityName,
			result: 'success',
			email: actorEmail,
			path: '/mcp',
			reason: options.successReason?.(result) ?? 'mcp_admin_capability',
		})
		return result
	} catch (error) {
		await logAuditEvent({
			db: auditDatabaseFromEnv(ctx.env),
			category: 'admin',
			action: capabilityName,
			result: 'failure',
			email: actorEmail,
			path: '/mcp',
			reason: getErrorReason(error),
		})
		throw error
	}
}

export function buildCreatedUserAuditReason(input: {
	stableUserId: string
	email: string
}) {
	return [
		`target_stable_user_id=${input.stableUserId}`,
		`target_email=${redactEmailRecipient(input.email)}`,
	].join(';')
}
