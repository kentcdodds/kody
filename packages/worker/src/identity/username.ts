import { dnsSafeUsernamePattern } from '@kody-internal/shared/public-urls.ts'
import { getReservedUsernameError } from '#worker/identity/reserved-usernames.ts'

export const usernameRequirements =
	'Username must be 3 to 32 characters, use only letters, numbers, and hyphens, and start and end with a letter or number.'

export function normalizeUsername(value: unknown) {
	return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Every username is a valid DNS label (`dnsSafeUsernamePattern` from
 * `@kody-internal/shared/public-urls.ts`): each user owns a `{username}.`
 * subdomain on the package-app domain. There is no lenient legacy shape —
 * the underscore-era usernames were migrated out of production on
 * 2026-08-12 (decision 0017).
 */
export function getUsernameFormatValidationError(username: string) {
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

export function getUsernameValidationError(username: string) {
	const formatError = getUsernameFormatValidationError(username)
	if (formatError) {
		return formatError
	}
	return getReservedUsernameError(username)
}
