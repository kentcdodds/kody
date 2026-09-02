import { expect, test, vi } from 'vitest'
import {
	getTurnstileSiteKey,
	honeypotFieldName,
	verifyPublicFormProtection,
} from '#app/public-form-protection.ts'
import { getSignupMode } from '#universal/signup-mode.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

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
		body: { [honeypotFieldName]: 'https://spam.example' },
	})
	expect(honeypot.ok).toBe(false)
	if (honeypot.ok) throw new Error('Expected honeypot rejection.')
	expect(honeypot.response.status).toBe(400)
	expect(await honeypot.response.json()).toEqual({
		error: 'Unable to submit this form.',
	})

	await expect(
		verifyPublicFormProtection({
			env: {},
			request,
			body: { website: 'https://kody.codes' },
		}),
	).resolves.toEqual({ ok: true })

	const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
		expect(init.method).toBe('POST')
		const body = new URLSearchParams(String(init.body))
		expect(body.get('secret')).toBe('secret-key')
		expect(['valid-token', 'foreign-host-token']).toContain(
			body.get('response'),
		)
		expect(body.get('remoteip')).toBe('203.0.113.11')
		return Response.json({
			success: true,
			hostname:
				body.get('response') === 'foreign-host-token'
					? 'kody-pr-99.kody-a99.workers.dev'
					: 'example.com',
		})
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
		expect(await missing.response.json()).toEqual({
			error: 'Please complete the human verification challenge.',
		})
		expect(fetchSpy).not.toHaveBeenCalled()

		await expect(
			verifyPublicFormProtection({
				env,
				request: turnstileRequest,
				body: { turnstileToken: 'valid-token' },
			}),
		).resolves.toEqual({ ok: true })
		expect(fetchSpy).toHaveBeenCalledOnce()

		fetchSpy.mockClear()
		consoleWarn.mockImplementation(() => {})
		const foreign = await verifyPublicFormProtection({
			env,
			request: turnstileRequest,
			body: { turnstileToken: 'foreign-host-token' },
		})
		expect(foreign.ok).toBe(false)
		if (foreign.ok) throw new Error('Expected foreign-hostname rejection.')
		expect(foreign.response.status).toBe(400)
		expect(await foreign.response.json()).toEqual({
			error: 'Human verification failed. Please try again.',
		})
		expect(consoleWarn).toHaveBeenCalledWith('turnstile-hostname-mismatch', {
			expected: 'example.com',
			received: 'kody-pr-99.kody-a99.workers.dev',
		})
	} finally {
		vi.unstubAllGlobals()
	}
})
