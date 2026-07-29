import { getReservedUsernameError } from '#worker/identity/reserved-usernames.ts'

export const usernameRequirements =
	'Username must be 3 to 32 characters, use only letters, numbers, hyphens, or underscores, and start and end with a letter or number.'

const usernamePattern = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])$/

export function normalizeUsername(value: unknown) {
	return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function getUsernameFormatValidationError(username: string) {
	if (!username) {
		return 'Username is required.'
	}
	if (!usernamePattern.test(username)) {
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
		.replace(/[^a-z0-9_-]+/g, '-')
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
