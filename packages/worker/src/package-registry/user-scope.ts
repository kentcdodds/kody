import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { getUsernameValidationError, normalizeUsername } from '#app/username.ts'

type UsernameRow = {
	username?: unknown
}

function normalizePackageScopeUsername(value: unknown) {
	const username = normalizeUsername(value)
	const validationError = getUsernameValidationError(username)
	if (validationError) {
		throw new Error(
			`Cannot validate package scope because the signed-in username is invalid: ${validationError}`,
		)
	}
	return username
}

export async function getMcpUserPackageScope(
	db: D1Database,
	user: McpUserContext,
) {
	const row = await db
		.prepare(
			`SELECT username
			FROM users
			WHERE lower(email) = lower(?)
			LIMIT 1`,
		)
		.bind(user.email)
		.first<UsernameRow>()
	if (!row) {
		throw new Error(
			'Cannot validate package scope because the signed-in user record was not found.',
		)
	}
	return normalizePackageScopeUsername(row.username)
}
