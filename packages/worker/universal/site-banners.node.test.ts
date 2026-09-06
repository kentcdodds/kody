import { expect, test } from 'vitest'
import {
	bannerIsScheduled,
	bannerMatchesAudience,
	bannerMatchesPath,
	compareSiteBannerPriority,
	createLaunchVideoSampleBanner,
	matchRoutePattern,
	parseBannerHref,
	parseSiteBannerInput,
	resolveVisibleSiteBanner,
	selectSiteBannersForClient,
	shouldHideSiteBanner,
	type SiteBannerRecord,
	type SiteBannerViewer,
} from './site-banners.ts'

const adminViewer: SiteBannerViewer = {
	loggedIn: true,
	stableUserId: 'a'.repeat(64),
	plan: 'pro',
	isAdmin: true,
}

const guestViewer: SiteBannerViewer = {
	loggedIn: false,
	stableUserId: null,
	plan: null,
	isAdmin: false,
}

function banner(overrides: Partial<SiteBannerRecord> = {}): SiteBannerRecord {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		enabled: true,
		priority: 10,
		title: 'Kody is live',
		body: 'Watch the launch video.',
		ctaHref: 'https://example.com/kody-launch-video',
		ctaLabel: 'Watch the video',
		secondaryHref: '/blog',
		secondaryLabel: 'Read the announcement',
		severity: 'promo',
		look: 'strip',
		icon: 'play',
		imageUrl: null,
		pageTargeting: 'all',
		routePatterns: [],
		audience: 'everyone',
		audienceUserIds: [],
		audiencePlans: [],
		dismissible: true,
		startsAt: null,
		endsAt: null,
		createdBy: 1,
		updatedBy: 1,
		createdAt: '2026-09-01T00:00:00.000Z',
		updatedAt: '2026-09-01T00:00:00.000Z',
		...overrides,
	}
}

test('route patterns match exact, single-segment, and suffix globs', () => {
	expect(matchRoutePattern('/blog', '/blog')).toBe(true)
	expect(matchRoutePattern('/blog/', '/blog')).toBe(true)
	expect(matchRoutePattern('/blog/hello', '/blog')).toBe(false)
	expect(matchRoutePattern('/blog/hello', '/blog/*')).toBe(true)
	expect(matchRoutePattern('/blog/hello/world', '/blog/*')).toBe(false)
	expect(matchRoutePattern('/blog/hello/world', '/blog/**')).toBe(true)
	expect(matchRoutePattern('/blog', '/blog/**')).toBe(true)
	expect(matchRoutePattern('/account/usage', '/account/**')).toBe(true)
	expect(matchRoutePattern('/pricing', '/account/**')).toBe(false)
})

test('page targeting all matches every path; routes requires a pattern hit', () => {
	expect(bannerMatchesPath(banner({ pageTargeting: 'all' }), '/pricing')).toBe(
		true,
	)
	expect(
		bannerMatchesPath(
			banner({ pageTargeting: 'routes', routePatterns: ['/pricing'] }),
			'/pricing',
		),
	).toBe(true)
	expect(
		bannerMatchesPath(
			banner({ pageTargeting: 'routes', routePatterns: ['/pricing'] }),
			'/',
		),
	).toBe(false)
})

test('audience matching covers everyone, auth state, users, and plans', () => {
	expect(
		bannerMatchesAudience(banner({ audience: 'everyone' }), guestViewer),
	).toBe(true)
	expect(
		bannerMatchesAudience(banner({ audience: 'logged_out' }), guestViewer),
	).toBe(true)
	expect(
		bannerMatchesAudience(banner({ audience: 'logged_out' }), adminViewer),
	).toBe(false)
	expect(
		bannerMatchesAudience(banner({ audience: 'logged_in' }), adminViewer),
	).toBe(true)
	expect(
		bannerMatchesAudience(
			banner({
				audience: 'users',
				audienceUserIds: [adminViewer.stableUserId ?? ''],
			}),
			adminViewer,
		),
	).toBe(true)
	expect(
		bannerMatchesAudience(
			banner({
				audience: 'users',
				audienceUserIds: ['b'.repeat(64)],
			}),
			adminViewer,
		),
	).toBe(false)
	expect(
		bannerMatchesAudience(
			banner({ audience: 'plans', audiencePlans: ['pro'] }),
			adminViewer,
		),
	).toBe(true)
	expect(
		bannerMatchesAudience(
			banner({ audience: 'plans', audiencePlans: ['max'] }),
			adminViewer,
		),
	).toBe(false)
})

test('schedule windows exclude banners before start or after end', () => {
	const now = Date.parse('2026-09-06T12:00:00.000Z')
	expect(
		bannerIsScheduled(banner({ startsAt: '2026-09-07T00:00:00.000Z' }), now),
	).toBe(false)
	expect(
		bannerIsScheduled(banner({ endsAt: '2026-09-05T00:00:00.000Z' }), now),
	).toBe(false)
	expect(
		bannerIsScheduled(
			banner({
				startsAt: '2026-09-01T00:00:00.000Z',
				endsAt: '2026-09-10T00:00:00.000Z',
			}),
			now,
		),
	).toBe(true)
})

test('highest priority eligible banner wins; dismissed banners lose', () => {
	const low = banner({
		id: '22222222-2222-4222-8222-222222222222',
		priority: 1,
		title: 'Low',
	})
	const high = banner({
		id: '33333333-3333-4333-8333-333333333333',
		priority: 50,
		title: 'High',
	})
	expect(
		resolveVisibleSiteBanner({
			candidates: [low, high],
			dismissedIds: [],
			pathname: '/',
			viewer: guestViewer,
		})?.title,
	).toBe('High')
	expect(
		resolveVisibleSiteBanner({
			candidates: [low, high],
			dismissedIds: [high.id],
			pathname: '/',
			viewer: guestViewer,
		})?.title,
	).toBe('Low')
})

test('priority ties break on newer updatedAt then id', () => {
	const older = banner({
		id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		priority: 10,
		updatedAt: '2026-09-01T00:00:00.000Z',
	})
	const newer = banner({
		id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		priority: 10,
		updatedAt: '2026-09-02T00:00:00.000Z',
	})
	expect(compareSiteBannerPriority(newer, older)).toBeLessThan(0)
	expect(
		resolveVisibleSiteBanner({
			candidates: [older, newer],
			dismissedIds: [],
			pathname: '/',
			viewer: guestViewer,
		})?.id,
	).toBe(newer.id)
})

test('auth and oauth shells hide banners unless an admin look preview is set', () => {
	expect(shouldHideSiteBanner('/login')).toBe(true)
	expect(shouldHideSiteBanner('/oauth/authorize')).toBe(true)
	expect(shouldHideSiteBanner('/')).toBe(false)
	expect(
		resolveVisibleSiteBanner({
			candidates: [banner()],
			dismissedIds: [],
			pathname: '/login',
			viewer: guestViewer,
		}),
	).toBeNull()
	expect(
		resolveVisibleSiteBanner({
			candidates: [],
			dismissedIds: [],
			pathname: '/',
			searchParams: new URLSearchParams('siteBannerLook=promo'),
			viewer: adminViewer,
		}),
	).toEqual(createLaunchVideoSampleBanner('promo'))
})

test('parseSiteBannerInput accepts a launch-video banner and rejects bad hrefs', () => {
	const parsed = parseSiteBannerInput({
		enabled: true,
		priority: 100,
		title: 'Kody is live',
		body: 'Watch the launch video.',
		ctaHref: 'https://example.com/kody-launch-video',
		ctaLabel: 'Watch the video',
		secondaryHref: '/blog',
		secondaryLabel: 'Read the announcement',
		severity: 'promo',
		look: 'promo',
		icon: 'play',
		pageTargeting: 'all',
		routePatterns: [],
		audience: 'everyone',
		audienceUserIds: [],
		audiencePlans: [],
		dismissible: true,
	})
	expect(parsed.ok).toBe(true)

	expect(parseBannerHref('javascript:alert(1)')).toBe(false)
	expect(parseBannerHref('//evil.example')).toBe(false)
	expect(parseBannerHref('http://example.com')).toBe(false)
	expect(parseBannerHref('/blog')).toBe('/blog')
	expect(parseBannerHref('https://example.com/kody-launch-video')).toBe(
		'https://example.com/kody-launch-video',
	)

	const missingCtaLabel = parseSiteBannerInput({
		enabled: true,
		priority: 1,
		title: 'Hi',
		body: '',
		ctaHref: '/blog',
		severity: 'info',
		look: 'strip',
		pageTargeting: 'all',
		audience: 'everyone',
		dismissible: false,
	})
	expect(missingCtaLabel.ok).toBe(false)
})

test('public client candidates drop targeted user ids and unmatched audiences', () => {
	const memberId = 'b'.repeat(64)
	const adminStableUserId = adminViewer.stableUserId ?? ''
	const publicBanner = banner({
		id: '11111111-1111-4111-8111-111111111111',
		audience: 'everyone',
	})
	const loggedInBanner = banner({
		id: '22222222-2222-4222-8222-222222222222',
		audience: 'logged_in',
		title: 'Members only',
	})
	const targeted = banner({
		id: '33333333-3333-4333-8333-333333333333',
		audience: 'users',
		audienceUserIds: [adminStableUserId],
		title: 'Just you',
		createdBy: 9,
		updatedBy: 9,
	})
	const otherUser = banner({
		id: '44444444-4444-4444-8444-444444444444',
		audience: 'users',
		audienceUserIds: [memberId],
		title: 'Someone else',
	})

	const guestCandidates = selectSiteBannersForClient({
		banners: [publicBanner, loggedInBanner, targeted, otherUser],
		viewer: guestViewer,
		includeUnmatched: false,
	})
	expect(guestCandidates.map((item) => item.id)).toEqual([publicBanner.id])
	expect(guestCandidates[0]?.audienceUserIds).toEqual([])

	const adminCandidates = selectSiteBannersForClient({
		banners: [publicBanner, loggedInBanner, targeted, otherUser],
		viewer: adminViewer,
		includeUnmatched: false,
	})
	expect(adminCandidates.map((item) => item.title)).toEqual([
		'Kody is live',
		'Members only',
		'Just you',
	])
	expect(adminCandidates.find((item) => item.title === 'Just you')).toEqual(
		expect.objectContaining({
			audience: 'logged_in',
			audienceUserIds: [],
			createdBy: null,
			updatedBy: null,
		}),
	)
	expect(JSON.stringify(adminCandidates)).not.toContain(memberId)
	expect(JSON.stringify(adminCandidates)).not.toContain(adminStableUserId)
})
