import { expect, test, vi } from 'vitest'
import { createVerifyEmailHandler } from '#app/handlers/verify-email.ts'
import { verifyEmailToken } from '#app/email-verification.ts'
import { renderAppPage } from '#app/ssr-render.tsx'

vi.mock('#app/email-verification.ts', () => ({
	verifyEmailToken: vi.fn(),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async ({ loaderData }) =>
		Response.json({ ok: true, loaderData }),
	),
}))

test('verify-email handler wires success CTA from redirectTo and rejects open redirects', async () => {
	vi.mocked(verifyEmailToken).mockResolvedValue({
		ok: true,
		userId: 1,
		email: 'verified@example.com',
	})
	const handler = createVerifyEmailHandler({
		APP_DB: {} as D1Database,
	} as Env)

	const oauthResume = '/oauth/authorize?client_id=demo'
	const oauthResponse = await handler.handler({
		request: new Request(
			`https://example.com/verify-email?token=ok&redirectTo=${encodeURIComponent(oauthResume)}`,
		),
		url: new URL(
			`https://example.com/verify-email?token=ok&redirectTo=${encodeURIComponent(oauthResume)}`,
		),
		params: {},
	} as never)
	expect(await oauthResponse.json()).toEqual({
		ok: true,
		loaderData: {
			emailVerification: {
				ok: true,
				kind: 'email_verify',
				message: expect.any(String),
				ctaHref: oauthResume,
				ctaLabel: 'Continue authorization',
			},
		},
	})

	const maliciousResponse = await handler.handler({
		request: new Request(
			'https://example.com/verify-email?token=ok&redirectTo=https%3A%2F%2Fevil.example',
		),
		url: new URL(
			'https://example.com/verify-email?token=ok&redirectTo=https%3A%2F%2Fevil.example',
		),
		params: {},
	} as never)
	expect(await maliciousResponse.json()).toEqual({
		ok: true,
		loaderData: {
			emailVerification: {
				ok: true,
				kind: 'email_verify',
				message: expect.any(String),
				ctaHref: '/onboarding',
				ctaLabel: 'Continue to onboarding',
			},
		},
	})

	expect(renderAppPage).toHaveBeenCalled()
})
