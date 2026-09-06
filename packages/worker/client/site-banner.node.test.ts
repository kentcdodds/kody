import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { SiteBanner, SiteBannerFrame } from './site-banner.tsx'
import { createLaunchVideoSampleBanner } from '#universal/site-banners.ts'

test('site banner SSR reserves look min-height and exposes test id', async () => {
	const html = await renderToString(
		jsx(SiteBannerFrame, {
			banner: createLaunchVideoSampleBanner('promo'),
		}),
	)
	expect(html).toContain('data-testid="site-banner"')
	expect(html).toContain('data-look="promo"')
	expect(html).toContain('Kody is live')
	expect(html).toContain('Watch the video')
	expect(html).toContain('min-height: 5.75rem')
	expect(html).toContain('width: 100%')
	expect(html).toContain('max-width: 100%')
	expect(html).toContain('padding-inline: 0')
	expect(html).toContain('align-self: stretch')
	expect(html).toContain('min-width: 0')
	expect(html).toContain('clamp(1.25rem, 4vw, 2.5rem)')
	expect(html).not.toContain('72%')
})

test('site banner snapshot resolves admin look override without a saved banner', async () => {
	const html = await renderToString(
		jsx(SiteBanner, {
			snapshot: {
				banner: null,
				candidates: [],
				dismissedIds: [],
				viewer: {
					loggedIn: true,
					stableUserId: 'a'.repeat(64),
					plan: 'pro',
					isAdmin: true,
				},
			},
		}),
	)
	// Without a look query on the SSR URL the snapshot has no banner.
	expect(html).not.toContain('data-testid="site-banner"')
})

test('each launch look paints a reserved height', async () => {
	for (const [look, minHeight] of [
		['strip', '3.25rem'],
		['promo', '5.75rem'],
		['card', '7.25rem'],
	] as const) {
		const html = await renderToString(
			jsx(SiteBannerFrame, {
				banner: createLaunchVideoSampleBanner(look),
				preview: true,
			}),
		)
		expect(html).toContain(`data-testid="site-banner-preview-${look}"`)
		expect(html).toContain(`min-height: ${minHeight}`)
	}
})
