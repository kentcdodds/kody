import { expect, test, vi } from 'vitest'
import { createVerifyEmailHandler } from '#app/handlers/verify-email.ts'
import { verifyEmailToken } from '#app/email-verification.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { sendConnectAgentEmail } from '#app/user-account-emails.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'

vi.mock('#app/email-verification.ts', () => ({
	verifyEmailToken: vi.fn(),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: vi.fn(async ({ loaderData }) =>
		Response.json({ ok: true, loaderData }),
	),
}))

vi.mock('#app/user-account-emails.ts', () => ({
	sendConnectAgentEmail: vi.fn(async () => true),
}))

vi.mock('#worker/kit/subscriber-sync.ts', () => ({
	scheduleKitSubscriberSync: vi.fn(),
}))

test('verify-email handler wires success CTA from redirectTo and rejects open redirects', async () => {
	vi.mocked(verifyEmailToken).mockResolvedValue({
		ok: true,
		userId: 1,
		email: 'verified@example.com',
		stableUserId: 'user_verified',
		newlyVerified: false,
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
	expect(sendConnectAgentEmail).not.toHaveBeenCalled()
	expect(scheduleKitSubscriberSync).not.toHaveBeenCalled()
})

test('verify-email sends the connect-agent mail only on newly verified accounts', async () => {
	vi.mocked(verifyEmailToken).mockResolvedValue({
		ok: true,
		userId: 1,
		email: 'verified@example.com',
		stableUserId: 'user_verified',
		newlyVerified: true,
	})
	const handler = createVerifyEmailHandler({
		APP_DB: {} as D1Database,
	} as Env)
	await handler.handler({
		request: new Request('https://example.com/verify-email?token=ok'),
		url: new URL('https://example.com/verify-email?token=ok'),
		params: {},
	} as never)
	expect(sendConnectAgentEmail).toHaveBeenCalledWith({
		env: expect.anything(),
		email: 'verified@example.com',
		userId: 'user_verified',
	})
	expect(scheduleKitSubscriberSync).toHaveBeenCalledWith({
		env: expect.anything(),
		email: 'verified@example.com',
		stableUserId: 'user_verified',
	})
})
