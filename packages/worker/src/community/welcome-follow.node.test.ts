import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { followDefaultWelcomeAccount } from './welcome-follow.ts'

type FakeUser = {
	username: string
	stable_user_id: string
	profile_visibility: 'public' | 'private'
}

function createFakeDb(input: {
	kody?: FakeUser | null
	onInsert?: (followerUserId: string, followeeUserId: string) => void
	failLookup?: boolean
}) {
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
								if (String(params[0]) !== 'kody' || !input.kody) return null
								return {
									id: 1,
									username: input.kody.username,
									email: 'kody@example.com',
									stable_user_id: input.kody.stable_user_id,
									display_name: null,
									bio: null,
									avatar_key: null,
									profile_visibility: input.kody.profile_visibility,
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

test('followDefaultWelcomeAccount follows public @kody and ignores missing/private/self', async () => {
	const inserts: Array<[string, string]> = []
	const publicDb = createFakeDb({
		kody: {
			username: 'kody',
			stable_user_id: 'stable-kody',
			profile_visibility: 'public',
		},
		onInsert: (followerUserId, followeeUserId) => {
			inserts.push([followerUserId, followeeUserId])
		},
	})
	await followDefaultWelcomeAccount({
		db: publicDb,
		followerUserId: 'stable-new-user',
	})
	expect(inserts).toEqual([['stable-new-user', 'stable-kody']])

	const missingDb = createFakeDb({ kody: null })
	await followDefaultWelcomeAccount({
		db: missingDb,
		followerUserId: 'stable-new-user',
	})

	const privateDb = createFakeDb({
		kody: {
			username: 'kody',
			stable_user_id: 'stable-kody',
			profile_visibility: 'private',
		},
		onInsert: () => {
			throw new Error('should not insert for private @kody')
		},
	})
	await followDefaultWelcomeAccount({
		db: privateDb,
		followerUserId: 'stable-new-user',
	})

	const selfDb = createFakeDb({
		kody: {
			username: 'kody',
			stable_user_id: 'stable-kody',
			profile_visibility: 'public',
		},
		onInsert: () => {
			throw new Error('should not self-follow @kody')
		},
	})
	await followDefaultWelcomeAccount({
		db: selfDb,
		followerUserId: 'stable-kody',
	})

	consoleWarn.mockImplementation(() => {})
	const failingDb = createFakeDb({ failLookup: true })
	await followDefaultWelcomeAccount({
		db: failingDb,
		followerUserId: 'stable-new-user',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'Failed to auto-follow @kody for new user:',
		expect.any(Error),
	)
})
