import { resolveUserStableId } from '#worker/user-id.ts'
import { getUserSocialRowByUsername, insertUserFollow } from './social-repo.ts'

export const defaultWelcomeFollowUsername = 'kody'

/**
 * Best-effort follow of the platform `@kody` account after signup. Missing,
 * private, or self `@kody` accounts are ignored so account creation never
 * fails on social-graph setup.
 */
export async function followDefaultWelcomeAccount(input: {
	db: D1Database
	followerUserId: string
}): Promise<void> {
	try {
		const followee = await getUserSocialRowByUsername(
			input.db,
			defaultWelcomeFollowUsername,
		)
		if (!followee || followee.profile_visibility === 'private') return
		const followeeUserId = resolveUserStableId(followee)
		if (followeeUserId === input.followerUserId) return
		await insertUserFollow(input.db, {
			followerUserId: input.followerUserId,
			followeeUserId,
		})
	} catch (error) {
		console.warn('Failed to auto-follow @kody for new user:', error)
	}
}
