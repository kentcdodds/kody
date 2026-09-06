import { expect, test } from 'vitest'
import {
	addDismissedBannerId,
	readSiteBannerDismissCookie,
	requestHasSiteBannerDismissCookie,
	siteBannerDismissCookie,
	siteBannerDismissCookieName,
} from './site-banner-cookie.ts'

const bannerId = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'

test('readSiteBannerDismissCookie parses valid ids and ignores junk', () => {
	expect(readSiteBannerDismissCookie(null)).toEqual([])
	expect(readSiteBannerDismissCookie('theme=dark')).toEqual([])
	expect(
		readSiteBannerDismissCookie(
			`other=1; ${siteBannerDismissCookieName}=${bannerId},${otherId},not-a-uuid`,
		),
	).toEqual([bannerId, otherId])
})

test('siteBannerDismissCookie writes HttpOnly ids and addDismissedBannerId is unique', () => {
	const header = siteBannerDismissCookie({
		ids: [bannerId, bannerId, 'nope'],
		secure: true,
	})
	expect(header).toContain(`${siteBannerDismissCookieName}=${bannerId}`)
	expect(header).toContain('HttpOnly')
	expect(header).toContain('Secure')
	expect(addDismissedBannerId([bannerId], otherId)).toEqual([bannerId, otherId])
	expect(addDismissedBannerId([bannerId], bannerId)).toEqual([bannerId])
})

test('requestHasSiteBannerDismissCookie matches only the dismiss cookie name', () => {
	expect(
		requestHasSiteBannerDismissCookie(new Request('https://example.com/')),
	).toBe(false)
	expect(
		requestHasSiteBannerDismissCookie(
			new Request('https://example.com/', {
				headers: { Cookie: 'kody_session=abc' },
			}),
		),
	).toBe(false)
	expect(
		requestHasSiteBannerDismissCookie(
			new Request('https://example.com/', {
				headers: { Cookie: `${siteBannerDismissCookieName}=${bannerId}` },
			}),
		),
	).toBe(true)
})
