import { findUserRowByStableUserId } from '#worker/user-id.ts'

export type PlatformFeedbackSubmitterIdentity = {
	userId: string
	username: string | null
	email: string | null
}

export async function resolvePlatformFeedbackSubmitterIdentity(
	db: D1Database,
	submitterUserId: string,
): Promise<PlatformFeedbackSubmitterIdentity> {
	const row = await findUserRowByStableUserId<{
		id: number
		username: string
		email: string
		stable_user_id: string | null
	}>({
		db,
		stableUserId: submitterUserId,
		select: `SELECT id, email, stable_user_id, username FROM users`,
	})
	return {
		userId: submitterUserId,
		username: row?.username ?? null,
		email: row?.email ?? null,
	}
}
