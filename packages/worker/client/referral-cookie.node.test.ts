import { expect, test } from 'vitest'
import {
	clearReferralCookie,
	persistReferralCookieFromLocation,
} from './referral-cookie.ts'
import { referralCookieName } from '#universal/referral-cookie.ts'

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

function restoreDocument() {
	if (originalDocument) {
		Object.defineProperty(globalThis, 'document', originalDocument)
	} else {
		Reflect.deleteProperty(globalThis, 'document')
	}
}

function installDocumentCookie() {
	let cookie = ''
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: {
			get cookie() {
				return cookie
			},
			set cookie(value: string) {
				cookie = value
			},
		},
	})
}

test('later share links overwrite the referral cookie for one week', () => {
	try {
		installDocumentCookie()
		expect(
			persistReferralCookieFromLocation(
				'https://kody.codes/signup?ref=Ada',
				false,
			),
		).toBe('ada')
		expect(document.cookie).toBe(
			`${referralCookieName}=ada; Path=/; Max-Age=604800; SameSite=Lax`,
		)

		expect(
			persistReferralCookieFromLocation(
				'https://kody.codes/signup?ref=KentCDodds',
				true,
			),
		).toBe('kentcdodds')
		expect(document.cookie).toBe(
			`${referralCookieName}=kentcdodds; Path=/; Max-Age=604800; SameSite=Lax; Secure`,
		)

		expect(
			persistReferralCookieFromLocation('https://kody.codes/signup', false),
		).toBeNull()
		expect(document.cookie).toContain('kentcdodds')

		clearReferralCookie(false)
		expect(document.cookie).toBe(
			`${referralCookieName}=; Path=/; Max-Age=0; SameSite=Lax`,
		)
	} finally {
		restoreDocument()
	}
})
