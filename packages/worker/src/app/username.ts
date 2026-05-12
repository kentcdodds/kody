export const usernameRequirements =
	'Username must be 3 to 32 characters, use only letters, numbers, hyphens, or underscores, and start and end with a letter or number.'

const usernamePattern = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])$/

export function normalizeUsername(value: unknown) {
	return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function getUsernameValidationError(username: string) {
	if (!username) {
		return 'Username is required.'
	}
	if (!usernamePattern.test(username)) {
		return usernameRequirements
	}
	return null
}
