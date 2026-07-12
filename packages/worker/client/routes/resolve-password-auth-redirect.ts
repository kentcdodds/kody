import { normalizeRedirectTo } from '#app/safe-redirect.ts'
import { buildPendingVerificationPath } from '#client/routes/pending-verification-path.ts'

/**
 * Chooses where password login/signup should land after a successful /auth
 * response. Signup that still needs email verification goes to the dedicated
 * pending page so users are not dropped into MCP connect flow. A safe
 * redirectTo (such as an OAuth authorize URL) is preserved for continue-after-verify.
 */
export function resolvePasswordAuthRedirect(input: {
	mode: 'login' | 'signup'
	requiresTwoFactor?: boolean
	emailVerificationRequired?: boolean
	redirectTo?: string | null
}) {
	const redirectTo = normalizeRedirectTo(input.redirectTo)
	if (input.requiresTwoFactor) {
		return redirectTo
			? `/verify?redirectTo=${encodeURIComponent(redirectTo)}`
			: '/verify'
	}
	if (input.mode === 'signup' && input.emailVerificationRequired) {
		return buildPendingVerificationPath(redirectTo)
	}
	return redirectTo ?? '/account'
}
