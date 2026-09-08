import { expect, test } from 'vitest'
import {
	applyYoutubeWatchToBannerDraft,
	bannerAfterSave,
	draftToPreview,
	emptyDraft,
} from './admin-banners-shared.ts'
import { type SiteBannerRecord } from '#universal/site-banners.ts'
import { youtubeThumbPath, youtubeWatchHref } from '#universal/youtube-watch.ts'

function banner(
	overrides: Pick<SiteBannerRecord, 'id' | 'title' | 'priority'>,
): SiteBannerRecord {
	return {
		enabled: true,
		body: '',
		ctaHref: null,
		ctaLabel: null,
		secondaryHref: null,
		secondaryLabel: null,
		severity: 'info',
		look: 'strip',
		icon: null,
		imageUrl: null,
		pageTargeting: 'all',
		routePatterns: [],
		audience: 'everyone',
		audienceUserIds: [],
		audiencePlans: [],
		dismissible: true,
		startsAt: null,
		endsAt: null,
		createdBy: null,
		updatedBy: null,
		createdAt: '2026-09-01T00:00:00.000Z',
		updatedAt: '2026-09-01T00:00:00.000Z',
		...overrides,
	}
}

test('bannerAfterSave selects the saved id, not the highest-priority row', () => {
	const created = banner({
		id: '22222222-2222-4222-8222-222222222222',
		title: 'New launch',
		priority: 1,
	})
	const existing = banner({
		id: '11111111-1111-4111-8111-111111111111',
		title: 'Older higher priority',
		priority: 50,
	})
	expect(bannerAfterSave([existing, created], created.id)?.title).toBe(
		'New launch',
	)
	expect(bannerAfterSave([existing, created], undefined)).toBeNull()
})

test('emptyDraft is a disabled promo banner with no hardcoded video', () => {
	const draft = emptyDraft()
	expect(draft.enabled).toBe(false)
	expect(draft.look).toBe('promo')
	expect(draft.title).toBe('')
	expect(draft.ctaHref).toBe('')
	expect(draft.imageUrl).toBe('')
})

test('applyYoutubeWatchToBannerDraft fills CTA and first-party thumb', () => {
	const videoId = 'QA0xYMAMjEg'
	const applied = applyYoutubeWatchToBannerDraft(
		emptyDraft(),
		`https://www.youtube.com/watch?v=${videoId}&list=PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY`,
	)
	expect(applied).toEqual({
		ok: true,
		draft: expect.objectContaining({
			ctaHref: youtubeWatchHref(videoId),
			ctaLabel: 'Watch',
			imageUrl: youtubeThumbPath(videoId),
		}),
	})
	expect(applyYoutubeWatchToBannerDraft(emptyDraft(), 'nope')).toEqual({
		ok: false,
		error:
			'Paste a YouTube watch URL, youtu.be link, or 11-character video id.',
	})
})

test('draftToPreview fills untitled copy and first-party watch URLs', () => {
	const videoId = 'QA0xYMAMjEg'
	const draft = {
		...emptyDraft(),
		body: 'Optional body',
		ctaHref: `https://www.youtube.com/watch?v=${videoId}`,
		ctaLabel: 'Watch',
	}
	expect(draftToPreview(draft, 'promo')).toEqual({
		id: 'preview-promo',
		title: 'Untitled banner',
		body: 'Optional body',
		ctaHref: youtubeWatchHref(videoId),
		ctaLabel: 'Watch',
		secondaryHref: null,
		secondaryLabel: null,
		severity: draft.severity,
		look: 'promo',
		icon: 'play',
		imageUrl: youtubeThumbPath(videoId),
		dismissible: true,
	})
})
