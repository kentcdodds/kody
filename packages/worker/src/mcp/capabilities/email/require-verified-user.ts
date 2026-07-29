import {
	emailVerificationRequiredMessage,
	isAccountEmailVerified,
} from '#worker/identity/email-verification-state.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'

/**
 * Defense-in-depth for the email domain: even though `/mcp` already rejects
 * unverified accounts centrally, every email capability re-checks
 * `users.email_verified_at` so email access stays gated on paths that do not
 * go through `handleMcpRequest` (execute runtime, jobs, future callers).
 */
export async function requireVerifiedEmailAccountUser(ctx: CapabilityContext) {
	const user = requireMcpUser(ctx.callerContext)
	const verified = await isAccountEmailVerified({
		db: ctx.env.APP_DB,
		email: user.email,
		stableUserId: user.userId,
	})
	if (!verified) {
		throw new Error(emailVerificationRequiredMessage)
	}
	return user
}
