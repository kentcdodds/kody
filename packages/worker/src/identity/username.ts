import { dnsSafeUsernamePattern } from '@kody-internal/shared/public-urls.ts'
import { getReservedUsernameError } from '#worker/identity/reserved-usernames.ts'

export const usernameRequirements =
	'Username must be 3 to 32 characters, use only letters, numbers, and hyphens, and start and end with a letter or number.'

/**
 * The shape usernames could take before the underscore ban. Existing accounts
 * may still carry underscores, so *recognition* of stored usernames (display
 * names, public user lookup, inbound email routing, `/@{username}` path
 * parsing) stays lenient — otherwise those accounts would silently lose every
 * username-addressed surface, not just hosted package-app subdomains.
 */
const legacyUsernamePattern = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])$/

export function normalizeUsername(value: unknown) {
	return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Recognition gate for usernames that may already exist in the database.
 * Accepts the legacy underscore shape; use
 * `getDnsSafeUsernameValidationError` when validating a new or changed
 * username or a package-app subdomain label.
 */
export function getUsernameFormatValidationError(username: string) {
	if (!username) {
		return 'Username is required.'
	}
	if (!legacyUsernamePattern.test(username)) {
		return usernameRequirements
	}
	return null
}

/**
 * Strict DNS-label validation (`dnsSafeUsernamePattern` from
 * `@kody-internal/shared/public-urls.ts`) for new/changed usernames and
 * package-app subdomain labels. Rejects the legacy underscore shape.
 */
export function getDnsSafeUsernameValidationError(username: string) {
	if (!username) {
		return 'Username is required.'
	}
	if (!dnsSafeUsernamePattern.test(username)) {
		return usernameRequirements
	}
	return null
}

/**
 * Derive a valid default username from an email local part, satisfying the
 * username format rules (3-32 chars, alphanumeric edges).
 */
export function usernameFromEmail(email: string) {
	const localPart = email.split('@')[0] ?? 'user'
	const normalized = localPart
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
	const truncated = normalized
		.slice(0, 32)
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
	return truncated.length >= 3 ? truncated : `user-${truncated || 'new'}`
}

/** Human-facing fallback display name for accounts without a username. */
export function displayNameFromEmail(email: string) {
	return email.split('@')[0] || 'user'
}

/** Display name for an account: its username, or an email fallback when unusable. */
export function resolveDisplayName(input: { email: string; username: string }) {
	return getUsernameFormatValidationError(input.username)
		? displayNameFromEmail(input.email)
		: input.username
}

/** Validation for a new or changed username: strict DNS label + reserved list. */
export function getUsernameValidationError(username: string) {
	const formatError = getDnsSafeUsernameValidationError(username)
	if (formatError) {
		return formatError
	}
	return getReservedUsernameError(username)
}
