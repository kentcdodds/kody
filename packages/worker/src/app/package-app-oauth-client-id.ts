import {
	dnsSafeUsernamePattern,
	isDnsSafeUsername,
} from '@kody-internal/shared/public-urls.ts'

/**
 * Package-app OAuth client ids are the package identity — no registration.
 * Accepted forms: `@owner/leaf`, `owner/leaf`, optionally URL-encoded.
 */

const kodyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type PackageAppOauthClientId = {
	username: string
	kodyId: string
	/** Canonical `owner/leaf` (no leading @). */
	clientId: string
}

export function parsePackageAppOauthClientId(
	raw: string | null | undefined,
): PackageAppOauthClientId | null {
	if (typeof raw !== 'string') return null
	const trimmed = decodeURIComponent(raw.trim())
	if (!trimmed) return null
	const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
	const slash = withoutAt.indexOf('/')
	if (slash <= 0 || slash === withoutAt.length - 1) return null
	const username = withoutAt.slice(0, slash).toLowerCase()
	const kodyId = withoutAt.slice(slash + 1)
	if (!isDnsSafeUsername(username)) return null
	if (!kodyIdPattern.test(kodyId)) return null
	// Reject nested paths / extra segments.
	if (kodyId.includes('/')) return null
	if (!dnsSafeUsernamePattern.test(username)) return null
	return {
		username,
		kodyId,
		clientId: `${username}/${kodyId}`,
	}
}

export function formatPackageAppOauthClientId(input: {
	username: string
	kodyId: string
}) {
	return `${input.username.trim().toLowerCase()}/${input.kodyId.trim()}`
}
