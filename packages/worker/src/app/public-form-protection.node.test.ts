import { afterEach, expect, test, vi } from 'vitest'
import {
	getTurnstileSiteKey,
	verifyPublicFormProtection,
} from '#app/public-form-protection.ts'
import { getSignupMode } from '#app/signup-mode.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

test('signup mode and Turnstile configuration default closed and degrade gracefully', async () => {
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
	const unconfigured = await verifyPublicFormProtection({
		env: {},
		request,
		body: {},
	})
	expect(unconfigured).toEqual({ ok: true })

	const honeypot = await verifyPublicFormProtection({
		env: {},
		request,
		body: { website: 'https://spam.example' },
	})
	expect(honeypot.ok).toBe(false)
	if (honeypot.ok) throw new Error('Expected honeypot rejection.')
	expect(honeypot.response.status).toBe(400)
})

test('configured Turnstile requires and verifies a token server-side', async () => {
	const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
		expect(init.method).toBe('POST')
		const body = new URLSearchParams(String(init.body))
		expect(body.get('secret')).toBe('secret-key')
		expect(body.get('response')).toBe('valid-token')
		expect(body.get('remoteip')).toBe('203.0.113.11')
		return Response.json({ success: true })
	})
	vi.stubGlobal('fetch', fetchSpy)
	const env = {
		TURNSTILE_SITE_KEY: 'site-key',
		TURNSTILE_SECRET_KEY: 'secret-key',
	}
	const request = new Request('https://example.com/auth', {
		method: 'POST',
		headers: { 'CF-Connecting-IP': '203.0.113.11' },
	})

	const missing = await verifyPublicFormProtection({
		env,
		request,
		body: {},
	})
	expect(missing.ok).toBe(false)
	if (missing.ok) throw new Error('Expected missing-token rejection.')
	expect(missing.response.status).toBe(400)
	expect(fetchSpy).not.toHaveBeenCalled()

	const verified = await verifyPublicFormProtection({
		env,
		request,
		body: { turnstileToken: 'valid-token' },
	})
	expect(verified).toEqual({ ok: true })
	expect(fetchSpy).toHaveBeenCalledOnce()
})
