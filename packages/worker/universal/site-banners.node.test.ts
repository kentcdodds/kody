import { expect, test } from 'vitest'
import {
	bannerIsScheduled,
	bannerMatchesAudience,
	bannerMatchesPath,
	compareSiteBannerPriority,
	matchRoutePattern,
	parseBannerHref,
	parseSiteBannerInput,
	resolveVisibleSiteBanner,
	selectSiteBannersForClient,
	shouldHideSiteBanner,
	toSiteBannerView,
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

test('route patterns, page targeting, audiences, and schedule windows gate eligibility', () => {
	const patterns: Array<[string, string, boolean]> = [
		['/blog', '/blog', true],
		['/blog/', '/blog', true],
		['/blog/hello', '/blog', false],
		['/blog/hello', '/blog/*', true],
		['/blog/hello/world', '/blog/*', false],
		['/blog/hello/world', '/blog/**', true],
		['/blog', '/blog/**', true],
		['/account/usage', '/account/**', true],
		['/pricing', '/account/**', false],
	]
	expect(
		patterns.filter(
			([path, pattern, want]) => matchRoutePattern(path, pattern) !== want,
		),
	).toEqual([])

	// Page targeting all matches every path; routes requires a pattern hit.
	const routesBanner = banner({
		pageTargeting: 'routes',
		routePatterns: ['/pricing'],
	})
	expect(bannerMatchesPath(banner({ pageTargeting: 'all' }), '/pricing')).toBe(
		true,
	)
	expect(bannerMatchesPath(routesBanner, '/pricing')).toBe(true)
	expect(bannerMatchesPath(routesBanner, '/')).toBe(false)

	const audiences: Array<
		[Partial<SiteBannerRecord>, SiteBannerViewer, boolean]
	> = [
		[{ audience: 'everyone' }, guestViewer, true],
		[{ audience: 'logged_out' }, guestViewer, true],
		[{ audience: 'logged_out' }, adminViewer, false],
		[{ audience: 'logged_in' }, adminViewer, true],
		[
			{ audience: 'users', audienceUserIds: [adminViewer.stableUserId ?? ''] },
			adminViewer,
			true,
		],
		[
			{ audience: 'users', audienceUserIds: ['b'.repeat(64)] },
			adminViewer,
			false,
		],
		[{ audience: 'plans', audiencePlans: ['pro'] }, adminViewer, true],
		[{ audience: 'plans', audiencePlans: ['max'] }, adminViewer, false],
	]
	expect(
		audiences.filter(
			([overrides, viewer, want]) =>
				bannerMatchesAudience(banner(overrides), viewer) !== want,
		),
	).toEqual([])

	const now = Date.parse('2026-09-06T12:00:00.000Z')
	const schedules: Array<[Partial<SiteBannerRecord>, boolean]> = [
		[{ startsAt: '2026-09-07T00:00:00.000Z' }, false],
		[{ endsAt: '2026-09-05T00:00:00.000Z' }, false],
		[
			{
				startsAt: '2026-09-01T00:00:00.000Z',
				endsAt: '2026-09-10T00:00:00.000Z',
			},
			true,
		],
	]
	expect(
		schedules.filter(
			([overrides, want]) => bannerIsScheduled(banner(overrides), now) !== want,
		),
	).toEqual([])
})

function resolve(
	candidates: Array<SiteBannerRecord>,
	options: Partial<Parameters<typeof resolveVisibleSiteBanner>[0]> = {},
) {
	return resolveVisibleSiteBanner({
		candidates,
		dismissedIds: [],
		pathname: '/',
		viewer: guestViewer,
		...options,
	})
}

const promoLookPreview = () => new URLSearchParams('siteBannerLook=promo')

test('highest priority eligible banner wins; dismissed banners lose; ties break on newer updatedAt', () => {
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
	expect(resolve([low, high])?.title).toBe('High')
	expect(resolve([low, high], { dismissedIds: [high.id] })?.title).toBe('Low')

	const older = banner({
		id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		updatedAt: '2026-09-01T00:00:00.000Z',
	})
	const newer = banner({
		id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		updatedAt: '2026-09-02T00:00:00.000Z',
	})
	expect(compareSiteBannerPriority(newer, older)).toBeLessThan(0)
	expect(resolve([older, newer])?.id).toBe(newer.id)
})

test('auth and oauth shells hide banners unless an admin look preview is set', () => {
	expect(shouldHideSiteBanner('/login')).toBe(true)
	expect(shouldHideSiteBanner('/oauth/authorize')).toBe(true)
	expect(shouldHideSiteBanner('/')).toBe(false)
	expect(resolve([banner()], { pathname: '/login' })).toBeNull()
	expect(
		resolve([], { searchParams: promoLookPreview(), viewer: adminViewer }),
	).toMatchObject({
		look: 'promo',
		title: 'Kody is live',
		ctaHref: '/?youtubeId=QA0xYMAMjEg',
		imageUrl: '/youtube-thumb/QA0xYMAMjEg',
	})
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

	const hrefs: Array<[string, string | false]> = [
		['javascript:alert(1)', false],
		['//evil.example', false],
		['http://example.com', false],
		['/blog', '/blog'],
		[
			'https://example.com/kody-launch-video',
			'https://example.com/kody-launch-video',
		],
	]
	expect(hrefs.map(([href]) => [href, parseBannerHref(href)])).toEqual(hrefs)

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
	const targeted = banner({
		id: '33333333-3333-4333-8333-333333333333',
		audience: 'users',
		audienceUserIds: [adminStableUserId],
		title: 'Just you',
		priority: 50,
		createdBy: 9,
		updatedBy: 9,
	})
	const otherUser = banner({
		id: '44444444-4444-4444-8444-444444444444',
		audience: 'users',
		audienceUserIds: [memberId],
		title: 'Someone else',
	})
	const select = (viewer: SiteBannerViewer, includeUnmatched: boolean) =>
		selectSiteBannersForClient({
			banners: [
				publicBanner,
				banner({
					id: '22222222-2222-4222-8222-222222222222',
					audience: 'logged_in',
					title: 'Members only',
				}),
				targeted,
				otherUser,
			],
			viewer,
			includeUnmatched,
		})

	const guestCandidates = select(guestViewer, false)
	expect(guestCandidates.map((item) => item.id)).toEqual([publicBanner.id])
	expect(guestCandidates[0]?.audienceUserIds).toEqual([])

	const adminCandidates = select(adminViewer, false)
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

	const previewCandidates = select(adminViewer, true)
	expect(previewCandidates.find((item) => item.id === otherUser.id)).toEqual(
		expect.objectContaining({ audience: 'users', audienceUserIds: [] }),
	)
	expect(previewCandidates.find((item) => item.id === targeted.id)).toEqual(
		expect.objectContaining({
			audience: 'logged_in',
			audienceUserIds: [],
			title: 'Just you',
		}),
	)
	expect(resolve(previewCandidates, { viewer: adminViewer })?.title).toBe(
		'Just you',
	)
	expect(
		resolve(previewCandidates, {
			searchParams: promoLookPreview(),
			viewer: adminViewer,
		})?.title,
	).toBe('Just you')
})

test('public banner views keep stored CTAs and derive first-party thumbs', () => {
	const videoId = 'QA0xYMAMjEg'
	const playlistWatchUrl = `https://www.youtube.com/watch?v=${videoId}&list=PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY`
	const onSiteWatchHref = `/?youtubeId=${videoId}`
	expect(
		toSiteBannerView(
			banner({
				ctaHref: playlistWatchUrl,
				secondaryHref: `https://youtu.be/${videoId}`,
				imageUrl: null,
			}),
		),
	).toMatchObject({
		ctaHref: playlistWatchUrl,
		secondaryHref: `https://youtu.be/${videoId}`,
		imageUrl: `/youtube-thumb/${videoId}`,
	})
	expect(
		toSiteBannerView(banner({ ctaHref: onSiteWatchHref, imageUrl: null })),
	).toMatchObject({
		ctaHref: onSiteWatchHref,
		imageUrl: `/youtube-thumb/${videoId}`,
	})
	expect(
		resolve([banner({ ctaHref: playlistWatchUrl, imageUrl: null })])?.ctaHref,
	).toBe(playlistWatchUrl)
})
