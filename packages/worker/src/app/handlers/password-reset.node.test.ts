import { beforeEach, expect, test, vi } from 'vitest'
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

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- this legacy suite clears shared hoisted mocks between tests.
beforeEach(() => {
	vi.clearAllMocks()
})

function createEnv(overrides: Partial<Env> = {}) {
	return {
		APP_DB: {} as D1Database,
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

test('password reset email sender is derived from APP_BASE_URL hostname', async () => {
	const handler = createPasswordResetRequestHandler(
		createEnv({ APP_BASE_URL: 'https://app.example.com/path' }),
	)

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
})

test('password reset email is skipped when APP_BASE_URL is not configured', async () => {
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
	} finally {
		warnSpy.mockRestore()
	}
})

test('unconfigured email log does not contain token or raw recipient', async () => {
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

test('configured email send does not log the token', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const handler = createPasswordResetRequestHandler(
		createEnv({ APP_BASE_URL: 'https://app.example.com' }),
	)

	try {
		const response = await handler.handler({
			request: createResetRequest(),
			url: new URL('https://request-origin.test/password-reset'),
			params: {},
		})

		expect(response.status).toBe(200)
		expect(mockModule.sendCloudflareEmail).toHaveBeenCalledTimes(1)

		const warnCalls = warnSpy.mock.calls
		for (const args of warnCalls) {
			const joined = args.map(String).join(' ')
			expect(joined).not.toContain('token=')
			expect(joined).not.toMatch(hexTokenPattern)
		}
	} finally {
		warnSpy.mockRestore()
	}
})
