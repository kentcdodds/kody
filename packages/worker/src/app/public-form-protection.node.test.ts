import { expect, test, vi } from 'vitest'
import {
	getTurnstileSiteKey,
	verifyPublicFormProtection,
} from '#app/public-form-protection.ts'
import { getSignupMode } from '#universal/signup-mode.ts'

test('public form protection defaults closed, rejects honeypots, and verifies Turnstile', async () => {
	expect(getSignupMode({} as Pick<Env, 'SIGNUP_MODE'>)).toBe('invite')
	expect(
		getSignupMode({
			SIGNUP_MODE: 'open',
		} as Pick<Env, 'SIGNUP_MODE'>),
	).toBe('open')
	expect(
		getTurnstileSiteKey({
			TURNSTILE_SITE_KEY: 'site-key',
		} as Pick<Env, 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'>),
	).toBeNull()

	const request = new Request('https://example.com/auth', {
		method: 'POST',
		headers: { 'CF-Connecting-IP': '203.0.113.10' },
	})
	await expect(
		verifyPublicFormProtection({
			env: {},
			request,
			body: {},
		}),
	).resolves.toEqual({ ok: true })

	const honeypot = await verifyPublicFormProtection({
		env: {},
		request,
		body: { website: 'https://spam.example' },
	})
	expect(honeypot.ok).toBe(false)
	if (honeypot.ok) throw new Error('Expected honeypot rejection.')
	expect(honeypot.response.status).toBe(400)

	const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
		expect(init.method).toBe('POST')
		const body = new URLSearchParams(String(init.body))
		expect(body.get('secret')).toBe('secret-key')
		expect(body.get('response')).toBe('valid-token')
		expect(body.get('remoteip')).toBe('203.0.113.11')
		return Response.json({ success: true })
	})
	vi.stubGlobal('fetch', fetchSpy)
	try {
		const env = {
			TURNSTILE_SITE_KEY: 'site-key',
			TURNSTILE_SECRET_KEY: 'secret-key',
		}
		const turnstileRequest = new Request('https://example.com/auth', {
			method: 'POST',
			headers: { 'CF-Connecting-IP': '203.0.113.11' },
		})

		const missing = await verifyPublicFormProtection({
			env,
			request: turnstileRequest,
			body: {},
		})
		expect(missing.ok).toBe(false)
		if (missing.ok) throw new Error('Expected missing-token rejection.')
		expect(missing.response.status).toBe(400)
		expect(fetchSpy).not.toHaveBeenCalled()

		await expect(
			verifyPublicFormProtection({
				env,
				request: turnstileRequest,
				body: { turnstileToken: 'valid-token' },
			}),
		).resolves.toEqual({ ok: true })
		expect(fetchSpy).toHaveBeenCalledOnce()
	} finally {
		vi.unstubAllGlobals()
	}
})
