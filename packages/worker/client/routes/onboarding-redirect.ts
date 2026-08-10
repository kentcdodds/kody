import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import { buildPendingVerificationPath } from '#client/routes/pending-verification-path.ts'

export const onboardingPath = '/onboarding'

/**
 * Onboarding URL, optionally carrying a safe nested resume target (for example
 * an OAuth authorize path) through verification or login.
 */
export function buildOnboardingPath(redirectTo?: string | null) {
	const safeRedirectTo = normalizeRedirectTo(redirectTo)
	if (!safeRedirectTo) return onboardingPath
	const params = new URLSearchParams({ redirectTo: safeRedirectTo })
	return `${onboardingPath}?${params.toString()}`
}

/**
 * Destination for unverified onboarding visitors. Preserves only a normalized
 * same-origin redirectTo so SPA behavior matches the server handler.
 */
export function resolveOnboardingPendingVerificationPath(
	redirectTo?: string | null,
) {
	return buildPendingVerificationPath(redirectTo)
}

/**
 * Login return path that keeps the user on onboarding and, when present, the
 * nested safe redirectTo after they authenticate again.
 */
export function resolveOnboardingLoginPath(redirectTo?: string | null) {
	return buildAuthLink('/login', buildOnboardingPath(redirectTo))
}
