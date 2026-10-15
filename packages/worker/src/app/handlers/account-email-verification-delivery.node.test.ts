import { beforeAll, expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountEmailVerificationDeliveryHandler } from './account-email-verification-delivery.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import {
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type StatementMeta = { changes: number; last_row_id: number }

function createDeliveryPollTestDb(options: {
	emailVerifiedAt?: string | null
	deliveryStatus?: string | null
	deliveryClass?: string | null
	deliveryAt?: string | null
}) {
	const user = {
		id: 1,
		email: 'poll-user@example.com',
		username: 'poll-user',
		password_hash: 'unused',
		stable_user_id: testStableUserIdFromEmail('poll-user@example.com'),
		email_verified_at: options.emailVerifiedAt ?? null,
		email_verification_delivery_status: options.deliveryStatus ?? null,
		email_verification_delivery_class: options.deliveryClass ?? null,
		email_verification_delivery_at: options.deliveryAt ?? null,
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
	}

	function createStatement(query: string) {
		const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
		const statement = {
			query: normalized,
			bind: () => statement,
			async all() {
				if (
					normalized.startsWith('select') &&
					normalized.includes('from "users"')
				) {
					return {
						results: [{ ...user }],
						meta: { changes: 0, last_row_id: 0 } satisfies StatementMeta,
					}
				}
				return {
					results: [],
					meta: { changes: 0, last_row_id: 0 } satisfies StatementMeta,
				}
			},
			async first() {
				if (isOrgBindingMembershipQuery(normalized)) {
					return mockPersonalOrgBindingRow(user.stable_user_id, user.username)
				}
				const result = await statement.all()
				return result.results[0] ?? null
			},
			async run() {
				return { meta: { changes: 0, last_row_id: 0 } }
			},
		}
		return statement
	}

	const db = {
		prepare: (query: string) => createStatement(query),
		async batch(statements: Array<{ query?: string }>) {
			return await executePreparedD1Batch(statements)
		},
		async exec() {
			return
		},
	} as unknown as D1Database

	return db
}

function createAppEnv(db: D1Database) {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		FLAG_EXPOSURES: { writeDataPoint() {} },
	} as unknown as Env
}

const session: AuthSession = {
	stableUserId: testStableUserIdFromEmail('poll-user@example.com'),
	email: 'poll-user@example.com',
	rememberMe: false,
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

function createPollClient(
	dbOptions: Parameters<typeof createDeliveryPollTestDb>[0] = {},
) {
	const { handler } = createAccountEmailVerificationDeliveryHandler(
		createAppEnv(createDeliveryPollTestDb(dbOptions)),
	)
	const send = async (signedIn = true) => {
		const request = new Request(
			'http://example.com/account/email-verification-delivery.json',
			{
				method: 'GET',
				headers: signedIn
					? {
							Accept: 'application/json',
							Cookie: await createAuthCookie(session, false),
						}
					: { Accept: 'application/json' },
			},
		)
		return handler({ request, url: new URL(request.url), params: {} } as never)
	}
	return { send }
}

test('delivery poll requires a session and returns no account fields when missing', async () => {
	const { send } = createPollClient({
		deliveryStatus: 'accepted',
		deliveryAt: '2026-10-15T12:00:00.000Z',
	})
	const response = await send(false)
	expect(response.status).toBe(401)
	expect(await response.json()).toEqual({ ok: false })
})

test('delivery poll returns only the signed-in caller delivery status', async () => {
	const { send } = createPollClient({
		deliveryStatus: 'delivered',
		deliveryAt: '2026-10-15T12:05:00.000Z',
	})
	const response = await send()
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		emailVerified: false,
		delivery: {
			status: 'delivered',
			class: null,
			at: '2026-10-15T12:05:00.000Z',
		},
	})
})

test('delivery poll clears delivery once the session email is verified', async () => {
	const { send } = createPollClient({
		emailVerifiedAt: '2026-10-15T12:10:00.000Z',
		deliveryStatus: 'delivered',
		deliveryAt: '2026-10-15T12:05:00.000Z',
	})
	const response = await send()
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		emailVerified: true,
		delivery: null,
	})
})
