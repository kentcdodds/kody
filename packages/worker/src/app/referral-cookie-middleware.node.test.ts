import { expect, test } from 'vitest'
import { createRouter } from 'remix/router'
import { createReferralCookieMiddleware } from './referral-cookie-middleware.ts'
import { referralCookieName } from '#universal/referral-cookie.ts'

test('referral middleware overwrites kody_ref and no-stores the response', async () => {
	const router = createRouter({
		middleware: [createReferralCookieMiddleware()],
	})
	router.get('/signup', {
		middleware: [],
		async handler() {
			return new Response('signup', {
				headers: { 'Cache-Control': 'public, max-age=60' },
			})
		},
	})

	const first = await router.fetch(
		new Request('http://localhost/signup?ref=Ada'),
	)
	expect(await first.text()).toBe('signup')
	expect(first.headers.get('Set-Cookie')).toBe(
		`${referralCookieName}=ada; Path=/; Max-Age=604800; SameSite=Lax`,
	)
	expect(first.headers.get('Cache-Control')).toBe('no-store')

	const later = await router.fetch(
		new Request('https://kody.codes/signup?ref=KentCDodds'),
	)
	expect(later.headers.get('Set-Cookie')).toBe(
		`${referralCookieName}=kentcdodds; Path=/; Max-Age=604800; SameSite=Lax; Secure`,
	)

	const untouched = await router.fetch(new Request('http://localhost/signup'))
	expect(untouched.headers.get('Set-Cookie')).toBeNull()
	expect(untouched.headers.get('Cache-Control')).toBe('public, max-age=60')
})
