import { z } from 'zod'
import {
	AdminEmailVerificationError,
	markAdminUserEmailVerified,
	mintAdminEmailVerificationUrl,
} from '#worker/identity/email-verification-admin.ts'
import {
	type AutomationTrigger,
	automationTriggerOf,
} from '#worker/authorization/authorize.ts'
import { getEnablementById } from '#worker/enablements/repo.ts'
import { stableUserHoldsRole } from '#worker/identity/permissions-db.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	adminMutationCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		stableUserId: stableUserIdSchema.optional(),
		email: z.string().email().optional().describe('Email address to verify.'),
		username: z.string().min(1).optional().describe('Username to verify.'),
		action: z
			.enum(['mark_verified', 'mint_verify_url'])
			.describe(
				'mark_verified sets email_verified_at after operator-confirmed ownership. mint_verify_url returns a one-time /verify-email link without sending kody.codes mail.',
			),
	})
	.refine(
		(value) =>
			[value.stableUserId, value.email, value.username].filter(
				(item) => item !== undefined,
			).length === 1,
		{ message: 'Provide exactly one of stableUserId, email, or username.' },
	)

const outputSchema = z.object({
	user: adminUserMetadataSchema,
	verifyUrl: z
		.string()
		.nullable()
		.describe(
			'One-time verification URL when action is mint_verify_url; otherwise null.',
		),
	expiresAt: z
		.number()
		.int()
		.nullable()
		.describe('Unix ms expiry of the minted token, or null.'),
})

/**
 * Whether `mint_verify_url` may run without a live person: a job, webhook, or
 * subscription run (or package code it started) of an enablement that is on
 * for the running package, whose enabler owns that package, is its org's
 * Owner, and holds the site `admin` role in D1 right now (the background
 * caller's roles are cached, so they are not trusted for revocation).
 */
async function isAllowedAutomatedMint(
	args: { action: 'mark_verified' | 'mint_verify_url' },
	ctx: CapabilityContext,
): Promise<boolean> {
	if (args.action !== 'mint_verify_url') return false
	const { request, user, storageContext } = ctx.callerContext
	const trigger = automationTriggerOf(request)
	const packageId = storageContext?.packageId
	if (!trigger || !request?.actor || !user?.userId || !packageId) return false
	const enablerId = String(request.actor.userId)
	if (enablerId !== String(user.userId)) return false
	if (request.membership?.role !== 'owner') return false
	const enablement = await getEnablementById({
		db: ctx.env.APP_DB,
		orgId: request.org.id,
		id: trigger.enablementId,
	})
	if (
		enablement?.state !== 'on' ||
		enablement.packageId !== packageId ||
		String(enablement.enablerUserId) !== enablerId
	) {
		return false
	}
	return await stableUserHoldsRole(ctx.env.APP_DB, enablerId, 'admin')
}

/**
 * Audit suffix for a run that passed {@link isAllowedAutomatedMint}; the
 * dispatch gate refuses every other automated call before the handler runs.
 */
function automatedMintAuditContext(
	trigger: AutomationTrigger | null,
	ctx: CapabilityContext,
): string | null {
	if (!trigger) return null
	return [
		`trigger=${trigger.type}`,
		`enablement_id=${trigger.enablementId}`,
		`package_id=${ctx.callerContext.storageContext?.packageId ?? ''}`,
	].join(';')
}

export const adminUserVerifyCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		requiresLivePerson: async (args, ctx) =>
			!(await isAllowedAutomatedMint(args, ctx)),
		name: 'adminUserVerify',
		description:
			'Mark one account email verified, or mint a one-time verify URL to send over a path that is not kody.codes. Admin-only; audited; never touches user content. mark_verified needs a live person; mint_verify_url also runs from a job, webhook, or subscription an admin enabled on their own package.',
		keywords: [
			'admin',
			'user',
			'verify',
			'email verification',
			'bounce',
			'fastmail',
			'mark verified',
			'verify link',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserVerify',
				async () => {
					const target = {
						stableUserId: args.stableUserId,
						email: args.email,
						username: args.username,
					}
					try {
						if (args.action === 'mark_verified') {
							const user = await markAdminUserEmailVerified(
								ctx.env.APP_DB,
								target,
							)
							return { user, verifyUrl: null, expiresAt: null }
						}
						const minted = await mintAdminEmailVerificationUrl({
							db: ctx.env.APP_DB,
							appBaseUrl: ctx.callerContext.baseUrl,
							target,
						})
						return {
							user: minted.user,
							verifyUrl: minted.verifyUrl,
							expiresAt: minted.expiresAt,
						}
					} catch (error) {
						// Missing users / already-verified are caller-clearable.
						if (error instanceof AdminEmailVerificationError) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
				},
				{
					successReason: ({ user }) =>
						`target_stable_user_id=${user.stableUserId};action=${args.action}`,
					reasonContext: automatedMintAuditContext(
						automationTriggerOf(ctx.callerContext.request),
						ctx,
					),
				},
			)
		},
	},
)
