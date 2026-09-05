import { expect, test } from 'vitest'
import {
	anonymousHtmlCacheControl,
	anonymousPersonalizedJsonCacheHeaders,
	anonymousVisibilityGatedCacheControl,
	isCacheableAnonymousPath,
	publicSharedJsonCacheHeaders,
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

	// Local dev: a browser-cached document would be what Vite's post-HMR page
	// reload shows instead of the edit.
	expect(
		resolveAppPageCacheControl({
			pathname: '/',
			session: null,
			request: request('https://example.com/'),
			responseSetsCookie: false,
			localDev: true,
		}),
	).toEqual({ cacheControl: 'no-store' })

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
			pathname: '/faq',
			session: null,
			request: request('https://example.com/faq'),
			responseSetsCookie: false,
		}).cacheControl,
	).toBe(anonymousHtmlCacheControl)

	expect(
		resolveAppPageCacheControl({
			pathname: '/onboarding',
			session: null,
			request: request('https://example.com/onboarding'),
			responseSetsCookie: false,
		}),
	).toEqual({
		cacheControl: anonymousHtmlCacheControl,
		vary: 'Cookie',
	})
	expect(
		resolveAppPageCacheControl({
			pathname: '/guides',
			session: null,
			request: request('https://example.com/guides'),
			responseSetsCookie: false,
		}).cacheControl,
	).toBe(anonymousHtmlCacheControl)
	expect(
		resolveAppPageCacheControl({
			pathname: '/guides/how-kody-works',
			session: null,
			request: request('https://example.com/guides/how-kody-works'),
			responseSetsCookie: false,
		}).cacheControl,
	).toBe(anonymousHtmlCacheControl)

	expect(isCacheableAnonymousPath('/guides/how-kody-works.json')).toBe(true)
	expect(isCacheableAnonymousPath('/guides/nested/path')).toBe(false)

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

	expect(publicSharedJsonCacheHeaders()).toEqual({
		'Cache-Control': anonymousHtmlCacheControl,
	})
	expect(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: false,
			request: request('https://example.com/onboarding.json'),
		}),
	).toEqual({
		'Cache-Control': anonymousHtmlCacheControl,
		Vary: 'Cookie',
	})
	expect(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: true,
			request: request('https://example.com/onboarding.json'),
		}),
	).toEqual({ 'Cache-Control': 'no-store' })
	expect(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: false,
			request: request(
				'https://example.com/onboarding.json',
				'kody_session=stale',
			),
		}),
	).toEqual({ 'Cache-Control': 'no-store' })
})

test('anonymous package pages are cacheable, but only successful documents', () => {
	for (const pathname of [
		'/@kentcdodds/sentry',
		'/@kentcdodds/sentry/tree/main',
		'/@kentcdodds/sentry/tree/main/src/index.ts',
		'/community/0e75b90a-1fd7-4a4a-9ae1-167384bbd227',
		'/community/0e75b90a-1fd7-4a4a-9ae1-167384bbd227/files/src',
	]) {
		expect(isCacheableAnonymousPath(pathname), pathname).toBe(true)
		expect(
			resolveAppPageCacheControl({
				pathname,
				session: null,
				request: request(`https://example.com${pathname}`),
				responseSetsCookie: false,
			}),
		).toEqual({
			cacheControl: anonymousVisibilityGatedCacheControl,
			vary: 'Cookie',
		})
	}
	expect(anonymousHtmlCacheControl).toMatch(/stale-while-revalidate/)
	expect(anonymousVisibilityGatedCacheControl).not.toMatch(
		/stale-while-revalidate/,
	)
	expect(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: false,
			request: request('https://example.com/x.json'),
			visibilityGated: true,
		}),
	).toEqual({
		'Cache-Control': anonymousVisibilityGatedCacheControl,
		Vary: 'Cookie',
	})
	// Owner-only and JSON shapes stay private.
	expect(isCacheableAnonymousPath('/@kentcdodds/sentry/settings')).toBe(false)
	expect(
		isCacheableAnonymousPath('/profiles/kentcdodds/packages/sentry.json'),
	).toBe(false)
	expect(isCacheableAnonymousPath('/account/packages/abc/files')).toBe(false)

	// A private package answers 401/404 to strangers; that answer changes the
	// moment the owner makes it public, so it is never shared.
	for (const status of [401, 404]) {
		expect(
			resolveAppPageCacheControl({
				pathname: '/@kentcdodds/secret',
				session: null,
				request: request('https://example.com/@kentcdodds/secret'),
				responseSetsCookie: false,
				status,
			}),
		).toEqual({ cacheControl: 'no-store' })
	}
	expect(
		resolveAppPageCacheControl({
			pathname: '/@kentcdodds/sentry',
			session: null,
			request: request(
				'https://example.com/@kentcdodds/sentry',
				'kody_session=x',
			),
			responseSetsCookie: false,
		}),
	).toEqual({ cacheControl: 'no-store' })
})
