import { expect, test } from 'vitest'
import {
	hrefMatchesSsrUrl,
	normalizeRouterHref,
} from './loader-data-context.tsx'

test('loader href helpers normalize URLs and compare pathname and search', () => {
	expect(normalizeRouterHref('/community?q=beta')).toBe('/community?q=beta')
	expect(normalizeRouterHref('https://kody.local/community?q=beta#top')).toBe(
		'/community?q=beta#top',
	)

	expect(hrefMatchesSsrUrl('/community?q=beta', '/community?q=beta')).toBe(true)
	expect(
		hrefMatchesSsrUrl(
			'https://kody.local/community?q=beta',
			'/community?q=beta',
		),
	).toBe(true)
	expect(hrefMatchesSsrUrl('/community?q=beta', '/community')).toBe(false)
	expect(hrefMatchesSsrUrl('/community', '/community?q=beta')).toBe(false)
	expect(
		hrefMatchesSsrUrl(
			'/account/package-invocation-tokens/token-1',
			'/account/package-invocation-tokens/token-1',
		),
	).toBe(true)
	expect(
		hrefMatchesSsrUrl(
			'/account/package-invocation-tokens/token-2',
			'/account/package-invocation-tokens/token-1',
		),
	).toBe(false)
})
