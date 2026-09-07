/**
 * Browser helper for the last-wins referral cookie. A later share link
 * overwrites the previous referrer for the rest of the one-week window.
 */

import { serializeReferralCookie } from '#universal/referral-cookie.ts'
import { parseReferralCode } from '#universal/referral-program.ts'

export function persistReferralCookieFromLocation(
	href: string = typeof window !== 'undefined' ? window.location.href : '',
	secure: boolean = typeof window !== 'undefined'
		? window.location.protocol === 'https:'
		: false,
): string | null {
	let url: URL
	try {
		url = new URL(href, 'https://kody.codes')
	} catch {
		return null
	}
	const code = parseReferralCode({ searchParams: url.searchParams })
	if (!code || typeof document === 'undefined') return code
	document.cookie = serializeReferralCookie({ code, secure })
	return code
}

export function clearReferralCookie(
	secure: boolean = typeof window !== 'undefined'
		? window.location.protocol === 'https:'
		: false,
) {
	if (typeof document === 'undefined') return
	document.cookie = serializeReferralCookie({ code: null, secure })
}
