import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { followDefaultWelcomeAccounts } from './welcome-follow.ts'

type FakeUser = {
	username: string
	stable_user_id: string
	profile_visibility: 'public' | 'private'
}

function createFakeDb(input: {
	users?: Record<string, FakeUser | null>
	onInsert?: (followerUserId: string, followeeUserId: string) => void
	failLookup?: boolean
}) {
	const users = input.users ?? {}
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first() {
							if (input.failLookup) throw new Error('db down')
							if (
								query.includes('FROM users') &&
								query.includes('username = ?')
							) {
								const username = String(params[0])
								const user = users[username]
								if (!user) return null
								return {
									id: 1,
									username: user.username,
									email: `${user.username}@example.com`,
									stable_user_id: user.stable_user_id,
									display_name: null,
									bio: null,
									avatar_key: null,
									profile_visibility: user.profile_visibility,
									created_at: '2026-01-01T00:00:00.000Z',
								}
							}
							return null
						},
						async run() {
							if (query.includes('INSERT INTO user_follows')) {
								input.onInsert?.(String(params[0]), String(params[1]))
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							return { meta: { changes: 0, last_row_id: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('followDefaultWelcomeAccounts follows public @kody and @kentcdodds', async () => {
	const inserts: Array<[string, string]> = []
	const publicDb = createFakeDb({
		users: {
			kody: {
				username: 'kody',
				stable_user_id: 'stable-kody',
				profile_visibility: 'public',
			},
			kentcdodds: {
				username: 'kentcdodds',
				stable_user_id: 'stable-kent',
				profile_visibility: 'public',
			},
		},
		onInsert: (followerUserId, followeeUserId) => {
			inserts.push([followerUserId, followeeUserId])
		},
	})
	await followDefaultWelcomeAccounts({
		db: publicDb,
		followerUserId: 'stable-new-user',
	})
	expect(inserts).toEqual([
		['stable-new-user', 'stable-kody'],
		['stable-new-user', 'stable-kent'],
	])

	const missingDb = createFakeDb({ users: {} })
	await followDefaultWelcomeAccounts({
		db: missingDb,
		followerUserId: 'stable-new-user',
	})

	const privateKentInserts: Array<[string, string]> = []
	const privateKentDb = createFakeDb({
		users: {
			kody: {
				username: 'kody',
				stable_user_id: 'stable-kody',
				profile_visibility: 'public',
			},
			kentcdodds: {
				username: 'kentcdodds',
				stable_user_id: 'stable-kent',
				profile_visibility: 'private',
			},
		},
		onInsert: (followerUserId, followeeUserId) => {
			privateKentInserts.push([followerUserId, followeeUserId])
		},
	})
	await followDefaultWelcomeAccounts({
		db: privateKentDb,
		followerUserId: 'stable-new-user',
	})
	expect(privateKentInserts).toEqual([['stable-new-user', 'stable-kody']])

	const selfDb = createFakeDb({
		users: {
			kody: {
				username: 'kody',
				stable_user_id: 'stable-kody',
				profile_visibility: 'public',
			},
			kentcdodds: {
				username: 'kentcdodds',
				stable_user_id: 'stable-kent',
				profile_visibility: 'public',
			},
		},
		onInsert: (_followerUserId, followeeUserId) => {
			if (followeeUserId === 'stable-kent') {
				throw new Error('should not self-follow @kentcdodds')
			}
		},
	})
	await followDefaultWelcomeAccounts({
		db: selfDb,
		followerUserId: 'stable-kent',
	})

	consoleWarn.mockImplementation(() => {})
	const failingDb = createFakeDb({ failLookup: true })
	await followDefaultWelcomeAccounts({
		db: failingDb,
		followerUserId: 'stable-new-user',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'Failed to auto-follow @kody for new user:',
		expect.any(Error),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'Failed to auto-follow @kentcdodds for new user:',
		expect.any(Error),
	)
})
