import { expect, test } from 'vitest'
import {
	readReferralCodeFromCookie,
	referralCookieName,
	resolveReferralCodeForSignup,
	serializeReferralCookie,
} from './referral-cookie.ts'

test('referral cookie last-wins, expires in one week, and signup prefers the current request', () => {
	expect(serializeReferralCookie({ code: 'KentCDodds', secure: false })).toBe(
		`${referralCookieName}=kentcdodds; Path=/; Max-Age=604800; SameSite=Lax`,
	)
	expect(serializeReferralCookie({ code: 'Ada', secure: true })).toBe(
		`${referralCookieName}=ada; Path=/; Max-Age=604800; SameSite=Lax; Secure`,
	)
	expect(serializeReferralCookie({ code: 'x', secure: false })).toBe(
		`${referralCookieName}=; Path=/; Max-Age=0; SameSite=Lax`,
	)

	expect(
		readReferralCodeFromCookie('other=1; kody_ref=KentCDodds; theme=dark'),
	).toBe('kentcdodds')
	expect(readReferralCodeFromCookie('kody_ref=ada; kody_ref=KentCDodds')).toBe(
		'kentcdodds',
	)
	expect(readReferralCodeFromCookie('kody_ref=not%20valid')).toBeNull()
	expect(readReferralCodeFromCookie(null)).toBeNull()

	expect(
		resolveReferralCodeForSignup({
			searchParams: new URLSearchParams('ref=Ada'),
			cookieHeader: 'kody_ref=kentcdodds',
		}),
	).toBe('ada')
	expect(
		resolveReferralCodeForSignup({
			body: { referralCode: 'Ada' },
			cookieHeader: 'kody_ref=kentcdodds',
		}),
	).toBe('ada')
	expect(
		resolveReferralCodeForSignup({
			searchParams: new URLSearchParams('utm_source=youtube'),
			cookieHeader: 'kody_ref=kentcdodds',
		}),
	).toBe('kentcdodds')
	expect(
		resolveReferralCodeForSignup({
			searchParams: new URLSearchParams(),
			cookieHeader: null,
		}),
	).toBeNull()
})
