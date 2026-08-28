import { expect, test } from 'vitest'
import {
	appendAttributionQueryParams,
	firstTouchAttributionToUserColumns,
	hasFirstTouchAttribution,
	parseFirstTouchAttribution,
	serializeFirstTouchAttributionForTransport,
} from './first-touch-attribution.ts'

test('first-touch attribution parses query and body, rejects unsafe paths, and serializes for transport', () => {
	const fromQuery = parseFirstTouchAttribution({
		searchParams: new URLSearchParams(
			'utm_source=youtube&utm_medium=video&utm_campaign=bwk-2026-08-27&utm_content=desc&utm_term=kody',
		),
		landingPath: '/signup',
		referrer: 'https://youtube.com/watch?v=1',
	})
	expect(fromQuery).toEqual({
		utmSource: 'youtube',
		utmMedium: 'video',
		utmCampaign: 'bwk-2026-08-27',
		utmContent: 'desc',
		utmTerm: 'kody',
		landingPath: '/signup',
		referrer: 'https://youtube.com/watch?v=1',
	})

	expect(
		parseFirstTouchAttribution({
			body: {
				utmSource: 'kody.codes',
				utmMedium: 'homepage',
				utmCampaign: 'signup',
				landingPath: '/signup',
			},
		}),
	).toEqual({
		utmSource: 'kody.codes',
		utmMedium: 'homepage',
		utmCampaign: 'signup',
		utmContent: null,
		utmTerm: null,
		landingPath: '/signup',
		referrer: null,
	})

	expect(
		parseFirstTouchAttribution({
			searchParams: new URLSearchParams('utm_source=%20youtube%20'),
			landingPath: '//evil.example',
		}),
	).toEqual({
		utmSource: 'youtube',
		utmMedium: null,
		utmCampaign: null,
		utmContent: null,
		utmTerm: null,
		landingPath: null,
		referrer: null,
	})

	const attribution = parseFirstTouchAttribution({
		searchParams: new URLSearchParams('utm_source=youtube&utm_medium=video'),
		landingPath: '/signup',
	})
	expect(hasFirstTouchAttribution(attribution)).toBe(true)
	expect(serializeFirstTouchAttributionForTransport(attribution)).toEqual({
		utmSource: 'youtube',
		utmMedium: 'video',
		landingPath: '/signup',
	})
	expect(firstTouchAttributionToUserColumns(attribution)).toEqual({
		utm_source: 'youtube',
		utm_medium: 'video',
		utm_campaign: null,
		utm_content: null,
		utm_term: null,
		first_touch_landing_path: '/signup',
		first_touch_referrer: null,
	})
	const params = new URLSearchParams()
	appendAttributionQueryParams(params, attribution)
	expect(params.get('utm_source')).toBe('youtube')
	expect(params.get('utm_medium')).toBe('video')
	expect(params.get('landing_path')).toBe('/signup')
})
