import { expect, test } from 'vitest'
import {
	anonymousHtmlCacheControl,
	requestHasSessionCookie,
	resolveAppPageCacheControl,
} from '#app/anonymous-html-cache.ts'

function request(url: string, cookie?: string) {
	return new Request(url, {
		headers: cookie ? { Cookie: cookie } : undefined,
	})
}

test('requestHasSessionCookie matches only the kody_session name', () => {
	expect(requestHasSessionCookie(request('https://example.com/'))).toBe(false)
	expect(
		requestHasSessionCookie(
			request('https://example.com/', 'theme=dark; other=1'),
		),
	).toBe(false)
	expect(
		requestHasSessionCookie(
			request('https://example.com/', 'kody_session=abc; other=1'),
		),
	).toBe(true)
	expect(
		requestHasSessionCookie(
			request('https://example.com/', 'not_kody_session=abc'),
		),
	).toBe(false)
})

test('anonymous marketing HTML is cacheable only without a session', () => {
	const cached = resolveAppPageCacheControl({
		pathname: '/',
		session: null,
		request: request('https://example.com/'),
		responseSetsCookie: false,
	})
	expect(cached).toEqual({
		cacheControl: anonymousHtmlCacheControl,
		vary: 'Cookie',
	})

	expect(
		resolveAppPageCacheControl({
			pathname: '/pricing',
			session: null,
			request: request('https://example.com/pricing'),
			responseSetsCookie: false,
		}).cacheControl,
	).toBe(anonymousHtmlCacheControl)

	expect(
		resolveAppPageCacheControl({
			pathname: '/account',
			session: null,
			request: request('https://example.com/account'),
			responseSetsCookie: false,
		}),
	).toEqual({ cacheControl: 'no-store' })

	expect(
		resolveAppPageCacheControl({
			pathname: '/',
			session: { id: 'user-1' },
			request: request('https://example.com/'),
			responseSetsCookie: false,
		}),
	).toEqual({ cacheControl: 'no-store' })

	expect(
		resolveAppPageCacheControl({
			pathname: '/',
			session: null,
			request: request('https://example.com/', 'kody_session=stale'),
			responseSetsCookie: false,
		}),
	).toEqual({ cacheControl: 'no-store' })

	expect(
		resolveAppPageCacheControl({
			pathname: '/',
			session: null,
			request: request('https://example.com/'),
			responseSetsCookie: true,
		}),
	).toEqual({ cacheControl: 'no-store' })
})
