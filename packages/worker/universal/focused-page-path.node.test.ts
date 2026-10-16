import { expect, test } from 'vitest'
import { isFocusedPagePathname } from './focused-page-path.ts'

test('capability approval pages are focused; other package pages keep site chrome', () => {
	expect(isFocusedPagePathname('/@kody/mau-chart/approve-capabilities')).toBe(
		true,
	)
	expect(
		isFocusedPagePathname('/account/packages/pkg-1/approve-capabilities'),
	).toBe(true)
	expect(isFocusedPagePathname('/@acme/-/approvals/bundle-1')).toBe(true)
	expect(isFocusedPagePathname('/oauth/package-app/authorize')).toBe(true)
	expect(isFocusedPagePathname('/oauth/authorize')).toBe(false)
	expect(isFocusedPagePathname('/@kody/mau-chart')).toBe(false)
	expect(isFocusedPagePathname('/@kody/mau-chart/settings')).toBe(false)
	expect(isFocusedPagePathname('/@kody/mau-chart/approve-publish')).toBe(false)
	expect(isFocusedPagePathname('/@kody')).toBe(false)
	expect(isFocusedPagePathname('/')).toBe(false)
})
