import { beforeAll, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	updatePackagesForUsernameChange: vi.fn(async () => ({
		updatedPackages: [] as Array<unknown>,
		skippedPackages: [],
	})),
	republishCommunityListingsAfterUsernameChange: vi.fn(async () => ({
		republishedPackageIds: [] as Array<string>,
		warnings: [],
	})),
	updateCommunityProfile: vi.fn(),
}))

vi.mock('#worker/package-registry/username-change-packages.ts', () => ({
	updatePackagesForUsernameChange: (...args: Array<unknown>) =>
		mocks.updatePackagesForUsernameChange(...(args as [])),
	republishCommunityListingsAfterUsernameChange: (...args: Array<unknown>) =>
		mocks.republishCommunityListingsAfterUsernameChange(...(args as [])),
}))

vi.mock('#worker/community/profile-service.ts', () => ({
	updateCommunityProfile: (...args: Array<unknown>) =>
		mocks.updateCommunityProfile(...args),
}))

import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { createAccountProfileApiHandler } from './account-profile.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { reservedUsernamesKvKey } from '#worker/identity/reserved-username-settings.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type TestUser = ReturnType<typeof createUser>

function createProfileTestDb(
	initialUsers: Array<TestUser>,
	options?: { persistUsernameUpdates?: boolean },
) {
	const persistUsernameUpdates = options?.persistUsernameUpdates !== false
	const users = new Map(initialUsers.map((user) => [user.id, { ...user }]))
	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					const updateUsername = () => {
						const [username, updatedAt, id] = params as Array<string | number>
						const user = users.get(Number(id))
						if (!user) return null
						if (
							Array.from(users.values()).some(
								(existingUser) =>
									existingUser.id !== user.id &&
									existingUser.username.toLowerCase() ===
										String(username).toLowerCase(),
							)
						) {
							throw new Error('UNIQUE constraint failed: users.username')
						}
						if (persistUsernameUpdates) {
							user.username = String(username)
						}
						user.updated_at = String(updatedAt)
						return user
					}
					const selectUser = () => {
						const needle = String(params[0] ?? '')
						const matchers: Array<[RegExp, (user: TestUser) => boolean]> = [
							[
								/"stable_user_id"\s*=/,
								(user) => user.stable_user_id === needle,
							],
							[/"id"\s*=/, (user) => user.id === Number(needle)],
							[
								/"username"\s*=/,
								(user) => user.username.toLowerCase() === needle.toLowerCase(),
							],
						]
						const matcher = matchers.find(([pattern]) =>
							pattern.test(normalizedQuery),
						)
						return matcher
							? (Array.from(users.values()).find(matcher[1]) ?? null)
							: null
					}
					const executeAll = async () => {
						if (normalizedQuery.includes('update "users"')) {
							const user = updateUsername()
							return {
								results: user ? [{ ...user }] : [],
								meta: { changes: user ? 1 : 0, last_row_id: 0 },
							}
						}
						const user =
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"')
								? selectUser()
								: null
						return {
							results: user ? [{ ...user }] : [],
							meta: { changes: 0, last_row_id: 0 },
						}
					}

					return {
						query,
						all: executeAll,
						async first() {
							const result = await executeAll()
							return result.results[0] ?? null
						},
						async run() {
							const user = normalizedQuery.includes('update "users"')
								? updateUsername()
								: null
							return { meta: { changes: user ? 1 : 0, last_row_id: 0 } }
						},
					}
				},
			}
		},
		async batch(statements: Array<{ query?: string }>) {
			return await executePreparedD1Batch(statements)
		},
		async exec() {
			return
		},
	} as unknown as D1Database

	return { db, users }
}

function createUser(id: number, username: string) {
	const email = `${username}@example.com`
	return {
		id,
		email,
		username,
		password_hash: 'unused',
		stable_user_id: testStableUserIdFromEmail(email),
		display_name: null as string | null,
		bio: null as string | null,
		avatar_key: null as string | null,
		profile_visibility: 'public' as 'public' | 'private',
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
	}
}

function createProfileClient(
	usernames: Array<string>,
	options: { persistUsernameUpdates?: boolean; kv?: KVNamespace } = {},
) {
	const testDb = createProfileTestDb(
		usernames.map((username, index) => createUser(index + 1, username)),
		options,
	)
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: testCookieSecret,
		APP_BASE_URL: 'http://example.com',
		...(options.kv ? { BUNDLE_ARTIFACTS_KV: options.kv } : {}),
	} as Env
	const { handler } = createAccountProfileApiHandler(env)
	const email = `${usernames[0]}@example.com`
	const send = async (body?: Record<string, unknown>) => {
		const cookie = await createAuthCookie(
			{
				stableUserId: testStableUserIdFromEmail(email),
				email,
				rememberMe: false,
			},
			false,
		)
		const request = new Request('http://example.com/account/profile.json', {
			method: body ? 'POST' : 'GET',
			headers: {
				Cookie: cookie,
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		})
		return handler({ request, url: new URL(request.url), params: {} } as never)
	}
	return {
		testDb,
		env,
		get: () => send(),
		post: (body: Record<string, unknown>) => send(body),
		username: () => testDb.users.get(1)?.username,
	}
}

function expectAccountAudit(action: string, result: string, extra = {}) {
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({ category: 'account', action, result, ...extra }),
	)
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('account profile API returns email and username for the signed-in user', async () => {
	const { get } = createProfileClient(['current-user'])

	const response = await get()

	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		email: 'current-user@example.com',
		emailVerified: false,
		emailVerificationDelivery: null,
		username: 'current-user',
		displayName: 'current-user',
		bio: null,
		avatarUrl: null,
		profileVisibility: 'public',
		formerEmails: [],
	})
	// Reads are not audited.
	expect(logAuditEventSpy).not.toHaveBeenCalled()
	expect(mocks.updatePackagesForUsernameChange).not.toHaveBeenCalled()
})

test('account profile API updates username for the signed-in user', async () => {
	const { post, username } = createProfileClient(['current-user'])
	mocks.updatePackagesForUsernameChange.mockResolvedValueOnce({
		updatedPackages: [
			{
				packageId: 'pkg-1',
				kodyId: 'demo',
				previousName: '@current-user/demo',
				nextName: '@next-jane/demo',
				publishedCommit: 'abc',
				changedPaths: ['package.json'],
				shouldRepublishCommunityListing: true,
			},
		],
		skippedPackages: [],
	})
	mocks.republishCommunityListingsAfterUsernameChange.mockResolvedValueOnce({
		republishedPackageIds: ['pkg-1'],
		warnings: [],
	})

	const response = await post({ username: 'Next-Jane' })

	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({
		ok: true,
		email: 'current-user@example.com',
		username: 'next-jane',
		displayName: 'next-jane',
		bio: null,
		profileVisibility: 'public',
		packagesUpdated: 1,
		communityListingsRepublished: 1,
		packageUpdateMessage: 'Updated 1 package to the new @next-jane scope.',
	})
	expect(username()).toBe('next-jane')
	expect(mocks.updateCommunityProfile).not.toHaveBeenCalled()
	expect(mocks.updatePackagesForUsernameChange).toHaveBeenCalledWith(
		expect.objectContaining({
			previousUsername: 'current-user',
			nextUsername: 'next-jane',
		}),
	)
	expect(
		mocks.republishCommunityListingsAfterUsernameChange,
	).toHaveBeenCalledWith(expect.objectContaining({ packageIds: ['pkg-1'] }))
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expectAccountAudit('update_username', 'success')
})

test('account profile API treats an unchanged username as a no-op so grandfathered reserved usernames can still save profile fields', async () => {
	// 'kody' is on the reserved username list; an account that already holds
	// it must still be able to save display name / bio / visibility.
	const { post, username } = createProfileClient(['kody'])
	mocks.updateCommunityProfile.mockResolvedValue(undefined)

	const response = await post({
		username: 'kody',
		displayName: 'Kody the Koala',
		bio: 'Hi',
	})

	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({ ok: true, username: 'kody' })
	expect(username()).toBe('kody')
	expect(mocks.updateCommunityProfile).toHaveBeenCalledWith(
		expect.objectContaining({
			numericUserId: 1,
			displayName: 'Kody the Koala',
			bio: 'Hi',
		}),
	)
	expect(logAuditEventSpy).not.toHaveBeenCalledWith(
		expect.objectContaining({ action: 'update_username' }),
	)
	expect(mocks.updatePackagesForUsernameChange).not.toHaveBeenCalled()
})

test('account profile API rejects username changes when package updates fail or the rename does not persist', async () => {
	const failing = createProfileClient(['current-user'])
	mocks.updatePackagesForUsernameChange.mockRejectedValueOnce(
		new Error('sync failed'),
	)

	const response = await failing.post({ username: 'next-jane' })

	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({
		ok: false,
		error:
			'Username was not changed because package updates failed: sync failed',
	})
	expect(failing.username()).toBe('current-user')
	expectAccountAudit('update_username', 'failure', {
		reason: 'package_scope_update_failed',
	})

	mocks.updatePackagesForUsernameChange.mockClear()
	const unpersisted = createProfileClient(['jklotz08'], {
		persistUsernameUpdates: false,
	})
	const unpersistedResponse = await unpersisted.post({ username: 'jklotz' })
	expect(unpersistedResponse.status).toBe(500)
	expect(await unpersistedResponse.json()).toEqual({
		ok: false,
		error: 'Username was not changed to `jklotz`.',
	})
	expect(unpersisted.username()).toBe('jklotz08')
	expect(mocks.updatePackagesForUsernameChange).not.toHaveBeenCalled()
})

test('account profile API rejects invalid, reserved, or duplicate usernames', async () => {
	const { post, username } = createProfileClient(['current-user', 'taken-jane'])

	expect((await post({ username: 'bad username' })).status).toBe(400)

	const rejections: Array<[string, number, string]> = [
		['kody', 400, '`kody` is reserved.'],
		['Taken-Jane', 409, '`taken-jane` is taken.'],
	]
	for (const [requested, status, error] of rejections) {
		const response = await post({ username: requested })
		expect([response.status, await response.json()]).toEqual([
			status,
			{ ok: false, error },
		])
	}
	expect(username()).toBe('current-user')
	expect(mocks.updatePackagesForUsernameChange).not.toHaveBeenCalled()
	// Only the duplicate attempt is audited; validation rejections are not.
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expectAccountAudit('update_username', 'failure', {
		reason: 'username_exists',
	})
})

test('account profile API round trips and validates displayName, bio, and visibility', async () => {
	const { testDb, env, get, post } = createProfileClient(['current-user'])
	const trimmedOrNull = (value: string) => value.trim() || null
	mocks.updateCommunityProfile.mockImplementation(
		async (input: {
			displayName?: string
			bio?: string
			visibility?: 'public' | 'private'
		}) => {
			const user = testDb.users.get(1)
			if (!user) return
			if (input.displayName !== undefined) {
				user.display_name = trimmedOrNull(input.displayName)
			}
			if (input.bio !== undefined) user.bio = trimmedOrNull(input.bio)
			if (input.visibility !== undefined) {
				user.profile_visibility = input.visibility
			}
		},
	)

	const response = await post({
		displayName: 'Current User',
		bio: 'I build packages',
		profileVisibility: 'private',
	})

	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		email: 'current-user@example.com',
		emailVerified: false,
		emailVerificationDelivery: null,
		username: 'current-user',
		displayName: 'Current User',
		bio: 'I build packages',
		avatarUrl: null,
		profileVisibility: 'private',
		formerEmails: [],
	})
	expect(mocks.updateCommunityProfile).toHaveBeenCalledWith({
		env,
		numericUserId: 1,
		displayName: 'Current User',
		bio: 'I build packages',
		visibility: 'private',
	})
	expectAccountAudit('update_profile', 'success')

	expect(await (await get()).json()).toMatchObject({
		displayName: 'Current User',
		bio: 'I build packages',
		profileVisibility: 'private',
	})

	const invalidVisibility = await post({ profileVisibility: 'friends' })
	expect(invalidVisibility.status).toBe(400)
	expect(await invalidVisibility.json()).toEqual({
		ok: false,
		error: 'Profile visibility is invalid.',
	})

	mocks.updateCommunityProfile.mockRejectedValue(
		new CommunityActionError('Display name must be at most 50 characters.'),
	)
	const invalidDisplayName = await post({ displayName: 'x'.repeat(51) })
	expect(invalidDisplayName.status).toBe(400)
	expect(await invalidDisplayName.json()).toEqual({
		ok: false,
		error: 'Display name must be at most 50 characters.',
	})
})

test('account profile username change consults KV reserved additions and removals', async () => {
	const kv = {
		async get(key: string, type?: string) {
			if (key !== reservedUsernamesKvKey) return null
			const raw = JSON.stringify({
				added: ['brandnew'],
				removed: ['faq'],
				updatedAt: '2026-09-02T00:00:00.000Z',
				updatedBy: 'admin-stable-id',
			})
			return type === 'json' ? JSON.parse(raw) : raw
		},
	} as unknown as KVNamespace
	const { post, username } = createProfileClient(['current-user'], { kv })

	const addedResponse = await post({ username: 'brandnew' })
	expect(addedResponse.status).toBe(400)
	expect(await addedResponse.json()).toEqual({
		ok: false,
		error: '`brandnew` is reserved.',
	})

	expect((await post({ username: 'faq' })).status).toBe(200)
	expect(username()).toBe('faq')
})
