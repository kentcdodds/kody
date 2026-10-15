import { expect, test } from 'vitest'
import {
	longestKnownProviderMarkPrefix,
	providerFromSlug,
} from './provider-from-slug.ts'

test('providerFromSlug keeps compound marks and collapses only into known families', () => {
	expect(providerFromSlug('linkedin')).toBe('linkedin')
	expect(providerFromSlug('google-calendar')).toBe('google')
	expect(providerFromSlug('google-youtube-brand')).toBe('google')
	expect(providerFromSlug('github-kent')).toBe('github')
	expect(providerFromSlug('x-kodykoala')).toBe('x')
	expect(providerFromSlug('kody-exchange')).toBe('kody-exchange')
	expect(providerFromSlug('kody-exchange-work')).toBe('kody-exchange')
	expect(providerFromSlug('cal-com')).toBe('cal-com')
	expect(providerFromSlug('cal-com-2')).toBe('cal-com')
	expect(providerFromSlug('my-custom-app')).toBe('my-custom-app')
	expect(longestKnownProviderMarkPrefix('kody-exchange-work')).toBe(
		'kody-exchange',
	)
	expect(longestKnownProviderMarkPrefix('google-calendar')).toBe(
		'google-calendar',
	)
})
