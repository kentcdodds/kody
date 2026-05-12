import { getUsernameValidationError } from '#app/username.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

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
	if (getUsernameValidationError(username)) return null

	const userRecord = await input.db
		.prepare(
			`SELECT id, username, email
				FROM users
				WHERE username = ?`,
		)
		.bind(username)
		.first<{ id: number; username: string; email: string }>()
	if (!userRecord) return null

	return {
		userId: userRecord.id,
		username: userRecord.username,
		email: userRecord.email,
		mcpUserId: await createStableUserIdFromEmail(userRecord.email),
	}
}
