import { normalizeRedirectTo } from '#app/safe-redirect.ts'

export const pendingVerificationPath = '/pending-verification'

/**
 * Pending-verification URL, optionally carrying a safe post-verify redirect
 * (for example an OAuth authorize path with its original query).
 */
export function buildPendingVerificationPath(redirectTo?: string | null) {
	const safeRedirectTo = normalizeRedirectTo(redirectTo)
	if (!safeRedirectTo) return pendingVerificationPath
	const params = new URLSearchParams({ redirectTo: safeRedirectTo })
	return `${pendingVerificationPath}?${params.toString()}`
}

/** Destination after email verification succeeds from the pending page. */
export function resolvePostVerificationRedirect(redirectTo?: string | null) {
	return normalizeRedirectTo(redirectTo) ?? '/onboarding'
}
