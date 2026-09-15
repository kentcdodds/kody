import { expect, test, vi } from 'vitest'
import { createVerifyEmailDestinationHandler } from '#app/handlers/verify-email-destination.ts'
import { verifyEmailDestinationToken } from '#worker/email/destination-verification.ts'
import { renderAppPage } from '#app/ssr-render.tsx'

vi.mock('#worker/email/destination-verification.ts', () => ({
	verifyEmailDestinationToken: vi.fn(),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async ({ loaderData }) =>
		Response.json({ ok: true, loaderData }),
	),
}))

vi.mock('#worker/audit-log.ts', () => ({
	auditDatabaseFromEnv: vi.fn(),
	getRequestIp: vi.fn(() => null),
	logAuditEvent: vi.fn(),
}))

test('verified destination CTA returns to the email inbox destinations panel', async () => {
	vi.mocked(verifyEmailDestinationToken).mockResolvedValue({
		ok: true,
		userId: 1,
		email: 'pager@example.com',
	})
	const handler = createVerifyEmailDestinationHandler({
		APP_DB: {} as D1Database,
	} as Env)

	const response = await handler.handler({
		request: new Request(
			'https://example.com/verify-email-destination?token=ok',
		),
		url: new URL('https://example.com/verify-email-destination?token=ok'),
		params: {},
	} as never)

	expect(await response.json()).toMatchObject({
		ok: true,
		loaderData: {
			emailVerification: {
				ok: true,
				kind: 'email_destination',
				ctaHref: '/account/email#email-destinations',
			},
		},
	})
	expect(renderAppPage).toHaveBeenCalled()
})

test('destination verify HEAD peeks without consuming and failures offer a resend path', async () => {
	vi.mocked(verifyEmailDestinationToken).mockResolvedValue({
		ok: true,
		userId: 1,
		email: 'pager@example.com',
	})
	const handler = createVerifyEmailDestinationHandler({
		APP_DB: {} as D1Database,
	} as Env)

	const head = await handler.handler({
		request: new Request(
			'https://example.com/verify-email-destination?token=ok',
			{ method: 'HEAD' },
		),
		url: new URL('https://example.com/verify-email-destination?token=ok'),
		params: {},
	} as never)
	expect(head.status).toBe(200)
	expect(await head.text()).toBe('')
	expect(verifyEmailDestinationToken).toHaveBeenCalledWith({
		db: expect.anything(),
		token: 'ok',
		consume: false,
	})

	vi.mocked(verifyEmailDestinationToken).mockResolvedValue({
		ok: false,
		reason: 'invalid_token',
	})
	const failed = await handler.handler({
		request: new Request(
			'https://example.com/verify-email-destination?token=nope',
		),
		url: new URL('https://example.com/verify-email-destination?token=nope'),
		params: {},
	} as never)
	expect(await failed.json()).toMatchObject({
		ok: true,
		loaderData: {
			emailVerification: {
				ok: false,
				kind: 'email_destination',
				reason: 'invalid_token',
				ctaHref: '/account/email#email-destinations',
			},
		},
	})
})
