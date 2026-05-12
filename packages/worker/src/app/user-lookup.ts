import { getUsernameValidationError } from '#app/username.ts'
import { createDb, usersTable } from '#worker/db.ts'
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

	const db = createDb(input.db)
	const userRecord = await db.findOne(usersTable, {
		where: { username },
	})
	if (!userRecord) return null

	return {
		userId: userRecord.id,
		username: userRecord.username,
		email: userRecord.email,
		mcpUserId: await createStableUserIdFromEmail(userRecord.email),
	}
}
