import { z } from 'zod'
import {
	auditDatabaseFromEnv,
	logAuditEvent,
	redactEmailRecipient,
} from '#worker/audit-log.ts'
import {
	emailVerificationDeliveryClassValues,
	emailVerificationDeliveryStatusValues,
} from '#universal/email-verification-delivery.ts'
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
		'Manual entitlement grant (users.plan). Manage plan writes this column. Ordinary Stripe subscribers keep this as free.',
	),
	manualPlan: planNameSchema.describe(
		'Same as plan: the admin/manual grant on users.plan.',
	),
	stripePlan: planNameSchema
		.nullable()
		.describe(
			'Stripe-derived paid tier from users.stripe_plan, or null when none.',
		),
	effectivePlan: planNameSchema.describe(
		'Higher of the manual grant and Stripe subscription. This is the plan entitlements enforce.',
	),
	stripeCustomerLinked: z
		.boolean()
		.describe('True when users.stripe_customer_id is set.'),
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
	email_verification_delivery: z
		.object({
			status: z.enum(emailVerificationDeliveryStatusValues),
			class: z.enum(emailVerificationDeliveryClassValues).nullable(),
			at: z.string().nullable(),
		})
		.nullable()
		.describe(
			'Latest signup/verify mail delivery outcome. Null when no verification send has been tracked.',
		),
	email_verification_delivery_detail: z
		.string()
		.nullable()
		.describe(
			'Truncated provider SMTP response or failure detail for the latest verification send.',
		),
	utm_source: z
		.string()
		.nullable()
		.describe('First-touch utm_source at signup.'),
	utm_medium: z
		.string()
		.nullable()
		.describe('First-touch utm_medium at signup.'),
	utm_campaign: z
		.string()
		.nullable()
		.describe('First-touch utm_campaign at signup.'),
	utm_content: z
		.string()
		.nullable()
		.describe('First-touch utm_content at signup.'),
	utm_term: z.string().nullable().describe('First-touch utm_term at signup.'),
	first_touch_landing_path: z
		.string()
		.nullable()
		.describe('First-touch landing path at signup (pathname only).'),
	first_touch_referrer: z
		.string()
		.nullable()
		.describe('First-touch document referrer at signup.'),
	first_mcp_connected_at: z
		.string()
		.nullable()
		.describe('First successful MCP/agent connection timestamp.'),
	first_execute_at: z
		.string()
		.nullable()
		.describe('First successful execute usage timestamp.'),
	first_saved_package_at: z
		.string()
		.nullable()
		.describe('First saved package timestamp.'),
	mcp_client_name: z
		.string()
		.nullable()
		.describe('First-seen MCP client/host name (e.g. claude-ai).'),
	last_active_at: z
		.string()
		.nullable()
		.describe(
			'Last activity day stamp (login, MCP, execute, package) for D2/D7 return.',
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
