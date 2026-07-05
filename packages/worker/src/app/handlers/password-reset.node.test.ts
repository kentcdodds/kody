import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#app/audit-log.ts'

const mockModule = vi.hoisted(() => ({
	createRecord: vi.fn(async () => undefined),
	deleteMany: vi.fn(async () => undefined),
	findOne: vi.fn(async () => ({
		id: 123,
		email: 'user@example.com',
	})),
	logAuditEvent: vi.fn(async () => undefined),
	sendCloudflareEmail: vi.fn(async () => ({ ok: true })),
}))

vi.mock('#worker/db.ts', () => ({
	createDb: () => ({
		create: mockModule.createRecord,
		deleteMany: mockModule.deleteMany,
		findOne: mockModule.findOne,
	}),
	passwordResetsTable: {},
	usersTable: {},
}))

vi.mock('#app/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => null,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		mockModule.sendCloudflareEmail(...args),
}))

const { createPasswordResetRequestHandler } =
	await import('./password-reset.ts')

function createPasswordResetD1Mock() {
	return {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind() {
					return {
						async run() {
							if (
								normalizedQuery.startsWith('delete from password_resets') ||
								normalizedQuery.startsWith('insert into password_resets')
							) {
								return { meta: { changes: 1, last_row_id: 1 } }
							}
							return { meta: { changes: 0, last_row_id: 0 } }
						},
					}
				},
			}
		},
		async exec() {
			return
		},
	} as unknown as D1Database
}

function createEnv(overrides: Partial<Env> = {}) {
	return {
		APP_DB: createPasswordResetD1Mock(),
		CLOUDFLARE_ACCOUNT_ID: 'account-id',
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
		CLOUDFLARE_API_TOKEN: 'api-token',
		...overrides,
	} as Env
}

function createResetRequest() {
	return new Request('https://request-origin.test/password-reset', {
		method: 'POST',
		body: JSON.stringify({ email: 'user@example.com' }),
	})
}

const hexTokenPattern = /[0-9a-f]{64}/i

test('password reset sends from the APP_BASE_URL hostname without logging the token', async () => {
	vi.clearAllMocks()
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const handler = createPasswordResetRequestHandler(
		createEnv({ APP_BASE_URL: 'https://app.example.com/path' }),
	)

	try {
		const response = await handler.handler({
			request: createResetRequest(),
			url: new URL('https://request-origin.test/password-reset'),
			params: {},
		})

		expect(response.status).toBe(200)
		expect(mockModule.sendCloudflareEmail).toHaveBeenCalledWith(
			{
				accountId: 'account-id',
				apiBaseUrl: 'https://api.cloudflare.test',
				apiToken: 'api-token',
			},
			expect.objectContaining({
				from: 'kody@app.example.com',
				to: 'user@example.com',
			}),
		)
		const [, message] = mockModule.sendCloudflareEmail.mock.calls[0]!
		expect((message as { text: string }).text).toContain(
			'https://app.example.com/reset-password?token=',
		)
		for (const args of warnSpy.mock.calls) {
			const joined = args.map(String).join(' ')
			expect(joined).not.toContain('token=')
			expect(joined).not.toMatch(hexTokenPattern)
		}
	} finally {
		warnSpy.mockRestore()
	}
})

test('password reset skips sending when APP_BASE_URL is missing and logs a redacted payload', async () => {
	vi.clearAllMocks()
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const handler = createPasswordResetRequestHandler(
		createEnv({ APP_BASE_URL: '' }),
	)

	try {
		const response = await handler.handler({
			request: createResetRequest(),
			url: new URL('https://request-origin.test/password-reset'),
			params: {},
		})

		expect(response.status).toBe(200)
		expect(mockModule.sendCloudflareEmail).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalledWith(
			'password-reset-email-sender-unconfigured',
			expect.any(String),
		)

		const warnCalls = warnSpy.mock.calls
		const emailMissingCall = warnCalls.find(
			(args) => args[0] === 'password-reset-email-sender-unconfigured',
		)
		expect(emailMissingCall).toBeDefined()

		const logPayload = emailMissingCall![1] as string
		expect(logPayload).not.toContain('token=')
		expect(logPayload).not.toMatch(hexTokenPattern)
		expect(logPayload).not.toContain('user@example.com')
		expect(logPayload).not.toContain('<html')
		expect(logPayload).not.toContain('reset-password')

		const parsed = JSON.parse(logPayload) as Record<string, unknown>
		expect(parsed).toHaveProperty('subject')
		expect(parsed.to).toBe('***@example.com')
	} finally {
		warnSpy.mockRestore()
	}
})
