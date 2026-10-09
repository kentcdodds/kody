import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const lifecycleMocks = vi.hoisted(() => ({
	scheduleUserCreatedEvent: vi.fn(),
}))

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		lifecycleMocks.scheduleUserCreatedEvent(...args),
	scheduleUserDeletedEvent: vi.fn(),
}))

const { createAuthProviderCallbackHandler } =
	await import('#app/handlers/auth-provider.ts')
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import {
	createAppEnv,
	createMigratedDb,
	getCookiePair,
	runHandler,
	seedUser,
	startProviderFlow,
	testCookieSecret,
} from '#worker/test-support/auth-provider-harness.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { isAccountWriteLeaseUsersQuery } from '#worker/test-support/user-meter.ts'

const msw = createMswNodeServer()

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

afterEach(() => {
	msw.resetHandlers()
})

afterAll(() => {
	msw.close()
})

type PurgeRace = 'after-writable-check' | 'before-connection-insert'

function withRacingPurge(
	db: D1Database,
	deletingAt: string,
	race: PurgeRace,
): D1Database {
	const originalPrepare = db.prepare.bind(db)
	const stamp = (query: string, ...params: Array<unknown>) =>
		originalPrepare(query)
			.bind(...params)
			.run()
	return {
		...db,
		prepare(query: string) {
			const statement = originalPrepare(query)
			const normalized = query.replace(/\s+/g, ' ').toLowerCase()
			const isWritableCheck = isAccountWriteLeaseUsersQuery(normalized)
			const isConnectionInsert = normalized.includes(
				'insert into oauth_connections',
			)
			if (race === 'after-writable-check' && isWritableCheck) {
				return {
					...statement,
					bind(...params: Array<unknown>) {
						const bound = statement.bind(...params)
						return {
							...bound,
							async first<T>() {
								const row = await bound.first<T>()
								await stamp(
									`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
									deletingAt,
									params[0],
								)
								return row
							},
						}
					},
				}
			}
			if (race === 'before-connection-insert' && isConnectionInsert) {
				return {
					...statement,
					bind(...params: Array<unknown>) {
						const bound = statement.bind(...params)
						return {
							...bound,
							async run() {
								await stamp(
									`UPDATE users SET deleting_at = ? WHERE deleting_at IS NULL`,
									deletingAt,
								)
								return bound.run()
							},
						}
					},
				}
			}
			return statement
		},
	} as D1Database
}

function countConnections(
	sqlite: ReturnType<typeof createMigratedDb>['sqlite'],
	userId: number,
) {
	return sqlite
		.prepare(
			`SELECT COUNT(*) AS count FROM oauth_connections WHERE user_id = ?`,
		)
		.get(userId)
}

async function sessionCookieFor(email: string) {
	return getCookiePair(
		await createAuthCookie(
			{
				stableUserId: testStableUserIdFromEmail(email),
				email,
				rememberMe: false,
			},
			false,
		),
	)
}

test('google sign-in does not reclaim a fenced unverified account, including purge races', async () => {
	const cases: Array<{ fence: 'preexisting' | PurgeRace; deletingAt: string }> =
		[
			{ fence: 'preexisting', deletingAt: '2026-09-01 12:00:00' },
			{ fence: 'after-writable-check', deletingAt: '2026-09-02 12:00:00' },
			{ fence: 'before-connection-insert', deletingAt: '2026-09-02 12:00:00' },
		]
	for (const { fence, deletingAt } of cases) {
		logAuditEventSpy.mockClear()
		const { sqlite, db: rawDb } = createMigratedDb()
		const db =
			fence === 'preexisting'
				? rawDb
				: withRacingPurge(rawDb, deletingAt, fence)
		const env = createAppEnv(db, {
			OAUTH_PROVIDER: {
				listUserGrants: async () => ({ items: [] }),
				revokeGrant: async () => undefined,
			},
		})
		await seedUser(sqlite, {
			id: 9,
			email: 'fenced-squat@example.com',
			username: 'fenced-squat',
			emailVerified: false,
		})
		if (fence === 'preexisting') {
			sqlite.exec(`UPDATE users SET deleting_at = '${deletingAt}' WHERE id = 9`)
		}
		msw.use(
			http.post('https://oauth2.googleapis.com/token', () =>
				HttpResponse.json({ access_token: 'google-access-token' }),
			),
			http.get('https://openidconnect.googleapis.com/v1/userinfo', () =>
				HttpResponse.json({
					sub: 'google-fenced-sub',
					email: 'fenced-squat@example.com',
					email_verified: true,
					name: 'Real Owner',
				}),
			),
		)

		const start = await startProviderFlow(
			env,
			'google',
			'http://example.com/auth/google',
		)
		const callbackResponse = await runHandler(
			createAuthProviderCallbackHandler(env),
			new Request(
				`http://example.com/auth/google/callback?code=google-auth-code&state=${start.state}`,
				{ headers: { Cookie: start.stateCookie } },
			),
			{ provider: 'google' },
		)
		const user = sqlite
			.prepare(`SELECT email_verified_at, deleting_at FROM users WHERE id = 9`)
			.get()
		expect({
			fence,
			status: callbackResponse.status,
			location: callbackResponse.headers.get('Location'),
			sessionCookie: callbackResponse.headers
				.getSetCookie()
				.some((cookie) => cookie.startsWith('kody_session=')),
			user,
			connections: countConnections(sqlite, 9),
		}).toEqual({
			fence,
			status: 302,
			location: '/login?oauthError=email-unavailable',
			sessionCookie: false,
			user: { email_verified_at: null, deleting_at: deletingAt },
			connections: { count: 0 },
		})
		expect(logAuditEventSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				category: 'auth',
				action: 'oauth_login',
				result: 'failure',
				reason: 'account_deleting',
			}),
		)
		msw.resetHandlers()
	}
})

test('signed-in unverified accounts cannot link a provider; verified accounts still can', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db, {
		GITHUB_CLIENT_ID: 'MOCK_GITHUB_CLIENT_ID',
		GITHUB_CLIENT_SECRET: 'MOCK_GITHUB_CLIENT_SECRET',
	})
	await seedUser(sqlite, {
		id: 31,
		email: 'squat-linker@example.com',
		username: 'squat-linker',
		emailVerified: false,
	})
	await seedUser(sqlite, {
		id: 32,
		email: 'verified-linker@example.com',
		username: 'verified-linker',
		emailVerified: true,
	})
	const linkGithub = async (email: string) => {
		const start = await startProviderFlow(
			env,
			'github',
			'http://example.com/auth/github',
		)
		return runHandler(
			createAuthProviderCallbackHandler(env),
			new Request(start.location, {
				headers: {
					Cookie: `${start.stateCookie}; ${await sessionCookieFor(email)}`,
				},
			}),
			{ provider: 'github' },
		)
	}

	const unverifiedResponse = await linkGithub('squat-linker@example.com')
	expect(unverifiedResponse.status).toBe(302)
	expect(unverifiedResponse.headers.get('Location')).toBe(
		'/account?oauthError=email-unverified',
	)
	expect(countConnections(sqlite, 31)).toEqual({ count: 0 })
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_login',
			result: 'failure',
			reason: 'email_unverified',
		}),
	)

	const verifiedResponse = await linkGithub('verified-linker@example.com')
	expect(verifiedResponse.status).toBe(302)
	expect(verifiedResponse.headers.get('Location')).toBe(
		'/account?oauthLinked=github',
	)
	expect(
		sqlite
			.prepare(
				`SELECT user_id FROM oauth_connections WHERE provider_name = 'github'`,
			)
			.get(),
	).toEqual({ user_id: 32 })
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_connection_linked',
			result: 'success',
			email: 'verified-linker@example.com',
		}),
	)
})
