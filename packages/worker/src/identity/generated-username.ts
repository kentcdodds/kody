import {
	getEffectiveUsernameValidationError,
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
 * provider handle or an email local part). Numeric suffixes are used only when
 * the base itself is claimable but taken — a reserved base still collides
 * after `-2` because reserved tokens of length 4+ match as substrings.
 * Otherwise a random compact candidate is drawn until one is claimable.
 */
export async function getAvailableUsernameFromBase(
	db: D1Database,
	base: string,
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
) {
	// Provider handles may contain characters the username format rejects;
	// map them the same way usernameFromEmail maps email local parts.
	const normalizedBase = normalizeUsername(base)
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
		.slice(0, 32)
		.replace(/[^a-z0-9]+$/g, '')

	const baseError = normalizedBase
		? await getEffectiveUsernameValidationError(normalizedBase, env)
		: 'Username is required.'
	if (
		normalizedBase &&
		!baseError &&
		!(await userExistsByUsername(db, normalizedBase))
	) {
		return normalizedBase
	}

	if (normalizedBase && !baseError) {
		const prefix = normalizedBase.slice(0, 27).replace(/-+$/g, '') || 'n'
		for (let suffix = 2; suffix <= 100; suffix += 1) {
			const candidate = `${prefix}-${suffix}`
			if (
				!(await getEffectiveUsernameValidationError(candidate, env)) &&
				!(await userExistsByUsername(db, candidate))
			) {
				return candidate
			}
		}
	}

	for (let attempt = 0; attempt < 32; attempt += 1) {
		const bytes = new Uint8Array(6)
		crypto.getRandomValues(bytes)
		const random = Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, '0'),
		)
			.join('')
			.toLowerCase()
		const candidate = `n${random}`
		if (
			!(await getEffectiveUsernameValidationError(candidate, env)) &&
			!(await userExistsByUsername(db, candidate))
		) {
			return candidate
		}
	}

	throw new Error('Unable to generate an available username.')
}

export async function getAvailableGeneratedUsername(
	db: D1Database,
	email: string,
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
) {
	return getAvailableUsernameFromBase(db, usernameFromEmail(email), env)
}
