import {
	normalizeRedirectTo,
	resolvePostVerificationRedirect,
} from '#app/safe-redirect.ts'

export { resolvePostVerificationRedirect }

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
