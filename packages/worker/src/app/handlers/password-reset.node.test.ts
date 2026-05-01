import { beforeEach, expect, test, vi } from 'vitest'

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

vi.mock('#app/audit-log.ts', () => ({
	getRequestIp: () => null,
	logAuditEvent: (...args: Array<unknown>) => mockModule.logAuditEvent(...args),
}))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		mockModule.sendCloudflareEmail(...args),
}))

const { createPasswordResetRequestHandler } =
	await import('./password-reset.ts')

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
			expect.stringContaining('Reset your password'),
		)
	} finally {
		warnSpy.mockRestore()
	}
})
