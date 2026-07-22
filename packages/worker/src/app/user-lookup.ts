import { getUsernameFormatValidationError } from '#app/username.ts'
import { resolveUserStableId } from '#worker/user-id.ts'

export type PublicUserIdentity = {
	userId: number
	username: string
	email: string
	mcpUserId: string
}

export async function findPublicUserIdentityByUsername(input: {
	db: D1Database
	username: string
}): Promise<PublicUserIdentity | null> {
	const username = input.username.trim()
	if (getUsernameFormatValidationError(username)) return null

	const userRecord = await input.db
		.prepare(
			`SELECT id, username, email, stable_user_id
				FROM users
				WHERE username = ?`,
		)
		.bind(username)
		.first<{
			id: number
			username: string
			email: string
			stable_user_id: string
		}>()
	if (!userRecord) return null

	return {
		userId: userRecord.id,
		username: userRecord.username,
		email: userRecord.email,
		mcpUserId: resolveUserStableId(userRecord),
	}
}

export async function resolvePublicUsername(input: {
	db: D1Database
	username?: string | null
	email?: string | null
}): Promise<string | null> {
	const username = input.username?.trim()
	if (username && !getUsernameFormatValidationError(username)) return username

	const email = input.email?.trim().toLowerCase()
	if (!email) return null

	const userRecord = await input.db
		.prepare(
			`SELECT username
				FROM users
				WHERE email = ?`,
		)
		.bind(email)
		.first<{ username: string | null }>()

	const resolvedUsername = userRecord?.username?.trim()
	return resolvedUsername && !getUsernameFormatValidationError(resolvedUsername)
		? resolvedUsername
		: null
}
