/**
 * Shared password-reset lockout: browser cookies, package-app cookies, and
 * MCP access tokens must all die at the same `users.password_changed_at`.
 */

/**
 * Parse a stored password_changed_at / SQLite-style timestamp to epoch ms.
 * Whole-second timestamps (no fractional seconds) are treated as the end of
 * that second so credentials issued later in the same second cannot survive a
 * reset that only recorded second precision.
 */
export function parsePasswordChangedAtMs(value: string | null | undefined) {
	if (!value) return null
	const trimmed = value.trim()
	if (!trimmed) return null
	const withT = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
	const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(withT)
	const normalized = hasTimezone ? withT : `${withT}Z`
	const ms = Date.parse(normalized)
	if (!Number.isFinite(ms)) return null
	const hasFractionalSeconds = /(?:[T ])\d{2}:\d{2}:\d{2}\.\d/.test(normalized)
	return hasFractionalSeconds ? ms : ms + 999
}

/**
 * True when `issuedAtMs` predates (or cannot prove it postdates) a password
 * change. Missing `issuedAtMs` fails closed once `passwordChangedAtMs` is set.
 */
export function isIssuedAtInvalidatedByPasswordChange(input: {
	issuedAtMs: number | undefined
	passwordChangedAtMs: number | null
}): boolean {
	if (input.passwordChangedAtMs == null) return false
	if (typeof input.issuedAtMs !== 'number') return true
	return input.issuedAtMs <= input.passwordChangedAtMs
}

/**
 * True when a credential predates the account's stored `password_changed_at`.
 *
 * Fail-closed when a stored timestamp exists but cannot be parsed. An account
 * that has never changed its password keeps credentials with no issued-at.
 */
export function isCredentialInvalidatedByStoredPasswordChange(input: {
	issuedAtMs: number | undefined
	storedPasswordChangedAt: string | null | undefined
}): boolean {
	const passwordChangedAtRaw = input.storedPasswordChangedAt?.trim() ?? ''
	const passwordChangedAtMs = parsePasswordChangedAtMs(passwordChangedAtRaw)
	if (passwordChangedAtRaw !== '' && passwordChangedAtMs === null) return true
	return isIssuedAtInvalidatedByPasswordChange({
		issuedAtMs: input.issuedAtMs,
		passwordChangedAtMs,
	})
}
