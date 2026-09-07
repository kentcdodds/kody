import { expect, test } from 'vitest'
import { faqRouteLoader } from './faq.tsx'
import { pricingRouteLoader } from './pricing.tsx'
import { resolveSignupPanel } from './login-shared.ts'
import {
	publicInviteSignupHref,
	publicSignupPrimaryCta,
	publicWaitlistSignupHref,
} from '#universal/public-signup-copy.ts'
import { parseSignupMode } from '#universal/signup-mode.ts'
import { routes } from '#universal/routes.ts'

test('public signup destinations open the matching signup panel', () => {
	const inviteUrl = new URL(publicInviteSignupHref, 'https://kody.codes')
	expect(inviteUrl.pathname).toBe(routes.signup.href())
	expect(resolveSignupPanel(inviteUrl.searchParams, 'waitlist')).toBe('invite')

	const waitlistUrl = new URL(publicWaitlistSignupHref, 'https://kody.codes')
	expect(waitlistUrl.pathname).toBe(routes.signup.href())
	expect(resolveSignupPanel(waitlistUrl.searchParams, 'invite')).toBe(
		'waiting-list',
	)

	expect(publicSignupPrimaryCta('open').href).toBe(routes.signup.href())
	expect(publicSignupPrimaryCta('invite').href).toBe(
		`${routes.home.href()}#invite`,
	)
	expect(publicSignupPrimaryCta('waitlist').href).toBe(
		publicSignupPrimaryCta('invite').href,
	)
})

test('FAQ and pricing loaders follow public auth config and fall back to invite', async () => {
	const originalFetch = globalThis.fetch
	const faqUrl = new URL('https://example.com/faq')
	const pricingUrl = new URL('https://example.com/pricing')
	const signal = new AbortController().signal

	globalThis.fetch = async (input) => {
		expect(String(input)).toContain('/auth/providers.json')
		return Response.json({
			ok: true,
			signupMode: 'waitlist',
			providers: [],
			turnstileSiteKey: null,
		})
	}
	try {
		expect(await faqRouteLoader(faqUrl, signal)).toEqual({
			signupMode: 'waitlist',
		})
		expect(await pricingRouteLoader(pricingUrl, signal)).toEqual({
			signupMode: 'waitlist',
		})
	} finally {
		globalThis.fetch = originalFetch
	}

	globalThis.fetch = async () => {
		throw new Error('auth config unavailable')
	}
	try {
		expect(await faqRouteLoader(faqUrl, signal)).toEqual({
			signupMode: 'invite',
		})
		expect(await pricingRouteLoader(pricingUrl, signal)).toEqual({
			signupMode: 'invite',
		})
		expect(parseSignupMode('not-a-mode')).toBe('invite')
		expect(parseSignupMode(undefined)).toBe('invite')
	} finally {
		globalThis.fetch = originalFetch
	}
})
