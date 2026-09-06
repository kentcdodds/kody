import { expect, test } from 'vitest'
import { bannerAfterSave } from './admin-banners-shared.ts'
import { type SiteBannerRecord } from '#universal/site-banners.ts'

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
