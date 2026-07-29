import {
	getUsernameValidationError,
	normalizeUsername,
	usernameFromEmail,
} from '#worker/identity/username.ts'

export async function userExistsByUsername(db: D1Database, username: string) {
	const row = await db
		.prepare(`SELECT id FROM users WHERE username = ?`)
		.bind(username)
		.first<{ id: number }>()
	return Boolean(row)
}

/**
 * Find an available username starting from a preferred base (for example a
 * provider handle or an email local part), falling back to numeric suffixes
 * and finally a random suffix.
 */
export async function getAvailableUsernameFromBase(
	db: D1Database,
	base: string,
) {
	// Provider handles may contain characters the username format rejects;
	// map them the same way usernameFromEmail maps email local parts.
	const normalizedBase = normalizeUsername(base)
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
		.slice(0, 32)
		.replace(/[^a-z0-9]+$/g, '')
	if (
		normalizedBase &&
		!getUsernameValidationError(normalizedBase) &&
		!(await userExistsByUsername(db, normalizedBase))
	) {
		return normalizedBase
	}

	const prefix =
		(normalizedBase || 'user').slice(0, 27).replace(/[-_]+$/g, '') || 'user'
	for (let suffix = 2; suffix <= 100; suffix += 1) {
		const candidate = `${prefix}-${suffix}`
		if (
			!getUsernameValidationError(candidate) &&
			!(await userExistsByUsername(db, candidate))
		) {
			return candidate
		}
	}

	const bytes = new Uint8Array(3)
	crypto.getRandomValues(bytes)
	const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.toLowerCase()
	return `user-${random}`
}

export async function getAvailableGeneratedUsername(
	db: D1Database,
	email: string,
) {
	return getAvailableUsernameFromBase(db, usernameFromEmail(email))
}
