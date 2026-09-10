import { expect, test } from 'vitest'
import { buildProviderStartPath } from './social-sign-in.ts'

test('buildProviderStartPath includes redirect and attribution query params', () => {
	expect(buildProviderStartPath('github', null)).toBe('/auth/github')
	expect(buildProviderStartPath('github', '/community')).toBe(
		'/auth/github?redirectTo=%2Fcommunity',
	)
	expect(
		buildProviderStartPath('github', null, {
			utmSource: 'youtube',
			utmMedium: 'video',
			utmCampaign: 'bwk',
			utmContent: null,
			utmTerm: null,
			landingPath: '/signup',
			referrer: null,
		}),
	).toBe(
		'/auth/github?utm_source=youtube&utm_medium=video&utm_campaign=bwk&landing_path=%2Fsignup',
	)
})
