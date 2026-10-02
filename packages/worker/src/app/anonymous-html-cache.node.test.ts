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

type PageCacheInput = Parameters<typeof resolveAppPageCacheControl>[0]

function request(url: string, cookie?: string) {
	return new Request(url, {
		headers: cookie ? { Cookie: cookie } : undefined,
	})
}

/** Anonymous GET of `pathname` on example.com unless overridden. */
function pageCache(pathname: string, overrides: Partial<PageCacheInput> = {}) {
	return resolveAppPageCacheControl({
		pathname,
		session: null,
		request: request(`https://example.com${pathname}`),
		responseSetsCookie: false,
		...overrides,
	})
}

const noStore = { cacheControl: 'no-store' }
const sharedHtml = { cacheControl: anonymousHtmlCacheControl, vary: 'Cookie' }

test('requestHasSessionCookie matches only the kody_session name', () => {
	const cases = [
		[undefined, false],
		['theme=dark; other=1', false],
		['kody_session=abc; other=1', true],
		['not_kody_session=abc', false],
	] as const
	for (const [cookie, expected] of cases) {
		expect(
			requestHasSessionCookie(request('https://example.com/', cookie)),
		).toBe(expected)
	}
})

test('anonymous marketing HTML is cacheable only without a session', () => {
	const sharedPaths = [
		'/',
		'/pricing',
		'/faq',
		'/case-studies',
		'/onboarding',
		'/onboarding/step-1',
		'/docs',
		'/docs/how-kody-works',
	]
	expect(
		sharedPaths.map((pathname) => [pathname, pageCache(pathname)]),
	).toEqual(sharedPaths.map((pathname) => [pathname, sharedHtml]))

	expect(isCacheableAnonymousPath('/docs/how-kody-works.json')).toBe(true)
	expect(isCacheableAnonymousPath('/docs/connect')).toBe(true)
	expect(isCacheableAnonymousPath('/docs/nested/path')).toBe(false)
	expect(isCacheableAnonymousPath('/onboarding/step-2/notion')).toBe(true)

	const privateCases: Array<[string, Partial<PageCacheInput>]> = [
		// Local dev: a browser-cached document would be what Vite's post-HMR page
		// reload shows instead of the edit.
		['/', { localDev: true }],
		[
			'/community',
			{
				request: new Request(
					'https://kody.codes/community?__frame=community-listings',
				),
			},
		],
		[
			'/community',
			{
				request: new Request('https://kody.codes/community', {
					headers: { 'x-remix-target': 'community-listings' },
				}),
			},
		],
		['/account', {}],
		['/', { session: { id: 'user-1' } }],
		[
			'/',
			{
				request: request(
					'https://example.com/',
					'kody_site_banner_dismiss=11111111-1111-4111-8111-111111111111',
				),
			},
		],
		['/', { request: request('https://example.com/', 'kody_session=stale') }],
		['/', { responseSetsCookie: true }],
	]
	for (const [pathname, overrides] of privateCases) {
		expect(pageCache(pathname, overrides)).toEqual(noStore)
	}

	expect(publicSharedJsonCacheHeaders()).toEqual({
		'Cache-Control': anonymousHtmlCacheControl,
	})
	const onboardingJson = request('https://example.com/onboarding.json')
	expect(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: false,
			request: onboardingJson,
		}),
	).toEqual({ 'Cache-Control': anonymousHtmlCacheControl, Vary: 'Cookie' })
	expect(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: true,
			request: onboardingJson,
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
	const packagePaths = [
		'/@kentcdodds/sentry',
		'/@kentcdodds/sentry/tree/main',
		'/@kentcdodds/sentry/tree/main/src/index.ts',
		'/community/0e75b90a-1fd7-4a4a-9ae1-167384bbd227',
		'/community/0e75b90a-1fd7-4a4a-9ae1-167384bbd227/files/src',
	]
	expect(
		packagePaths.filter((pathname) => !isCacheableAnonymousPath(pathname)),
	).toEqual([])
	const visibilityGated = {
		cacheControl: anonymousVisibilityGatedCacheControl,
		vary: 'Cookie',
	}
	expect(
		packagePaths.map((pathname) => [pathname, pageCache(pathname)]),
	).toEqual(packagePaths.map((pathname) => [pathname, visibilityGated]))
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
	expect(
		[
			'/@kentcdodds/sentry/settings',
			'/profiles/kentcdodds/packages/sentry.json',
			'/account/packages/abc/files',
			'/@kentcdodds/sentry.git',
			'/@kentcdodds/sentry.git/info/refs',
			'/@kentcdodds/sentry.git/git-upload-pack',
		].filter(isCacheableAnonymousPath),
	).toEqual([])

	// A private package answers 401/404 to strangers; that answer changes the
	// moment the owner makes it public, so it is never shared.
	for (const status of [401, 404]) {
		expect(pageCache('/@kentcdodds/secret', { status })).toEqual(noStore)
	}
	expect(
		pageCache('/@kentcdodds/sentry', {
			request: request(
				'https://example.com/@kentcdodds/sentry',
				'kody_session=x',
			),
		}),
	).toEqual(noStore)
})
