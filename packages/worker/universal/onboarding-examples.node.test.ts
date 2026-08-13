import { expect, test } from 'vitest'
import {
	isOnboardingExampleListing,
	onboardingExampleListingIds,
	selectOnboardingExampleListings,
	selectOnboardingServiceStarterListings,
} from './onboarding-examples.ts'

test('selects zero-auth examples in the known production order', () => {
	const featured = [
		{
			id: 'other-oauth',
			kodyId: 'github-helper',
			name: '@kody/github-helper',
			description: 'Needs GitHub',
			iconUrl: '/icon.png',
			tags: ['github', 'oauth'],
		},
		{
			id: onboardingExampleListingIds[1],
			kodyId: 'hn-pulse',
			name: '@kody/hn-pulse',
			description: 'HN',
			iconUrl: '/icon.png',
			tags: ['example', 'zero-auth'],
		},
		{
			id: onboardingExampleListingIds[0],
			kodyId: 'local-conditions',
			name: '@kody/local-conditions',
			description: 'Weather',
			iconUrl: '/icon.png',
			tags: ['example', 'zero-auth'],
		},
		{
			id: onboardingExampleListingIds[2],
			kodyId: 'personal-capture',
			name: '@kody/personal-capture',
			description: 'Notes',
			iconUrl: '/icon.png',
			tags: ['example'],
		},
	]

	expect(
		selectOnboardingExampleListings(featured).map((row) => row.kodyId),
	).toEqual(['local-conditions', 'hn-pulse', 'personal-capture'])
	expect(
		selectOnboardingServiceStarterListings(featured).map((row) => row.kodyId),
	).toEqual(['github-helper'])
	expect(
		isOnboardingExampleListing({
			id: onboardingExampleListingIds[2],
			tags: [],
		}),
	).toBe(true)
})
