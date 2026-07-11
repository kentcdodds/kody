import { beforeAll, expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import {
	consoleError,
	consoleInfo,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { createAccountResendVerificationHandler } from './account-resend-verification.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type StatementMeta = { changes: number; last_row_id: number }

function createResendTestDb(options: { emailVerifiedAt?: string | null } = {}) {
	const user = {
		id: 1,
		email: 'resend-user@example.com',
		username: 'resend-user',
		password_hash: 'unused',
		email_verified_at: options.emailVerifiedAt ?? null,
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
	}
	const state = {
		verificationInserts: 0,
		verificationDeletes: 0,
		rateLimitAttempts: 0,
		rateLimitMax: 3,
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
				if (normalized.includes('insert into "email_verifications"')) {
					state.verificationInserts += 1
					return {
						results: [],
						meta: { changes: 1, last_row_id: 1 } satisfies StatementMeta,
					}
				}
				return {
					results: [],
					meta: { changes: 0, last_row_id: 0 } satisfies StatementMeta,
				}
			},
			async first() {
				const result = await statement.all()
				return result.results[0] ?? null
			},
			async run() {
				if (/delete from "?email_verifications"?/.test(normalized)) {
					state.verificationDeletes += 1
				}
				if (/insert into "?email_verifications"?/.test(normalized)) {
					state.verificationInserts += 1
				}
				if (normalized.includes('delete from _rate_limits')) {
					state.rateLimitAttempts = Math.max(0, state.rateLimitAttempts - 1)
				}
				return { meta: { changes: 1, last_row_id: 1 } }
			},
		}
		return statement
	}

	const db = {
		prepare: (query: string) => createStatement(query),
		async batch(statements: Array<{ query?: string }>) {
			if (
				statements.some((statement) =>
					statement.query?.includes('create table'),
				)
			) {
				return statements.map(() => ({
					meta: { changes: 0, last_row_id: 0 },
				}))
			}
			state.rateLimitAttempts += 1
			const allowed = state.rateLimitAttempts <= state.rateLimitMax
			return [
				{ meta: { changes: 0, last_row_id: 0 } },
				{ meta: { changes: allowed ? 1 : 0, last_row_id: 0 } },
			]
		},
		async exec() {
			return
		},
	} as unknown as D1Database

	return { db, state }
}

function createAppEnv(db: D1Database, overrides: Record<string, unknown> = {}) {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		...overrides,
	} as unknown as Parameters<typeof createAccountResendVerificationHandler>[0]
}

async function createResendRequest(session: AuthSession) {
	const cookie = await createAuthCookie(session, false)
	return new Request('http://example.com/account/resend-verification.json', {
		method: 'POST',
		headers: { Cookie: cookie },
	})
}

async function runHandler(
	handler: ReturnType<typeof createAccountResendVerificationHandler>,
	request: Request,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

const session: AuthSession = {
	id: '1',
	email: 'resend-user@example.com',
	rememberMe: false,
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('resend verification requires an authenticated session', async () => {
	const testDb = createResendTestDb()
	const handler = createAccountResendVerificationHandler(
		createAppEnv(testDb.db),
	)

	const response = await runHandler(
		handler,
		new Request('http://example.com/account/resend-verification.json', {
			method: 'POST',
		}),
	)
	expect(response.status).toBe(401)
	expect(testDb.state.verificationInserts).toBe(0)
})

test('resend verification issues a fresh token for unverified accounts and rate-limits repeats', async () => {
	const testDb = createResendTestDb({ emailVerifiedAt: null })
	const handler = createAccountResendVerificationHandler(
		createAppEnv(testDb.db),
	)

	for (let attempt = 1; attempt <= 3; attempt++) {
		const response = await runHandler(
			handler,
			await createResendRequest(session),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			ok: true,
			message: 'Verification email sent. Check your inbox.',
		})
	}
	expect(testDb.state.verificationInserts).toBe(3)
	expect(testDb.state.verificationDeletes).toBe(3)
	// No email sender is configured in this test env, so each resend logs
	// the send as skipped at info level.
	expect(consoleInfo).toHaveBeenCalledWith(
		'email-verification-send-skipped',
		expect.any(Number),
	)

	const rateLimitedResponse = await runHandler(
		handler,
		await createResendRequest(session),
	)
	expect(rateLimitedResponse.status).toBe(429)
	expect(rateLimitedResponse.headers.get('Retry-After')).toBeTruthy()
	expect(await rateLimitedResponse.json()).toEqual({
		ok: false,
		error: 'Too many verification emails requested. Please try again later.',
	})
	// No new token is created for rate-limited requests.
	expect(testDb.state.verificationInserts).toBe(3)
	// Three successful resends plus the rate-limited attempt are audited.
	expect(logAuditEventSpy).toHaveBeenCalledTimes(4)
	expect(logAuditEventSpy).toHaveBeenNthCalledWith(
		3,
		expect.objectContaining({
			category: 'auth',
			action: 'email_verification_resend',
			result: 'success',
		}),
	)
	expect(logAuditEventSpy).toHaveBeenNthCalledWith(
		4,
		expect.objectContaining({
			category: 'auth',
			action: 'email_verification_resend',
			result: 'rate_limited',
		}),
	)
})

test('resend verification rejects already-verified accounts', async () => {
	const testDb = createResendTestDb({
		emailVerifiedAt: new Date(0).toISOString(),
	})
	const handler = createAccountResendVerificationHandler(
		createAppEnv(testDb.db),
	)

	const response = await runHandler(handler, await createResendRequest(session))
	expect(response.status).toBe(400)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Your email is already verified.',
	})
	expect(testDb.state.verificationInserts).toBe(0)
})

test('resend verification surfaces send failures without pretending success', async () => {
	consoleError.mockImplementation(() => {})
	consoleWarn.mockImplementation(() => {})
	const testDb = createResendTestDb({ emailVerifiedAt: null })
	const handler = createAccountResendVerificationHandler(
		createAppEnv(testDb.db, {
			CLOUDFLARE_ACCOUNT_ID: 'cf-account-test',
			CLOUDFLARE_API_TOKEN: 'cf-token-test',
			CLOUDFLARE_API_BASE_URL: 'https://cloudflare-api.example.com',
		}),
	)
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json(
				{ success: false, errors: [{ message: 'delivery refused' }] },
				{ status: 500 },
			),
		),
	)

	const response = await runHandler(handler, await createResendRequest(session))
	expect(response.status).toBe(502)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Unable to send the verification email. Please try again later.',
	})
	// The failed send refunds the consumed rate-limit slot.
	expect(testDb.state.rateLimitAttempts).toBe(0)
	// The freshly inserted token is discarded again on send failure, so no
	// net-new token remains and prior tokens stay untouched.
	expect(testDb.state.verificationInserts).toBe(1)
	expect(testDb.state.verificationDeletes).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		expect.any(String),
		expect.any(Error),
	)
	// The failed Cloudflare API send is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-failed',
		expect.any(String),
	)
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'email_verification_resend',
			result: 'failure',
			reason: 'send_failed',
		}),
	)
	vi.unstubAllGlobals()
})
