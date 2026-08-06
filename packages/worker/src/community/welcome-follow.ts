import { resolveUserStableId } from '#worker/user-id.ts'
import { getUserSocialRowByUsername, insertUserFollow } from './social-repo.ts'

export const defaultWelcomeFollowUsernames = ['kody', 'kentcdodds'] as const

/**
 * Best-effort follows after signup so new timelines are not empty. Missing,
 * private, or self accounts are skipped so account creation never fails on
 * social-graph setup.
 */
export async function followDefaultWelcomeAccounts(input: {
	db: D1Database
	followerUserId: string
}): Promise<void> {
	for (const username of defaultWelcomeFollowUsernames) {
		try {
			const followee = await getUserSocialRowByUsername(input.db, username)
			if (!followee || followee.profile_visibility === 'private') continue
			const followeeUserId = resolveUserStableId(followee)
			if (followeeUserId === input.followerUserId) continue
			await insertUserFollow(input.db, {
				followerUserId: input.followerUserId,
				followeeUserId,
			})
		} catch (error) {
			console.warn(`Failed to auto-follow @${username} for new user:`, error)
		}
	}
}
