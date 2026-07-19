export type PlatformFeedbackSubmitterIdentity = {
	userId: string
	username: string | null
	email: string | null
}

export async function resolvePlatformFeedbackSubmitterIdentity(
	db: D1Database,
	submitterUserId: string,
): Promise<PlatformFeedbackSubmitterIdentity> {
	const row = await db
		.prepare(
			`SELECT username, email
			FROM users
			WHERE stable_user_id = ?
			LIMIT 1`,
		)
		.bind(submitterUserId)
		.first<{ username: string; email: string }>()
	return {
		userId: submitterUserId,
		username: row?.username ?? null,
		email: row?.email ?? null,
	}
}
