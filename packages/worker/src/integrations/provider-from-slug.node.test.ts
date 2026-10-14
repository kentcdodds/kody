import { expect, test } from 'vitest'
import { isKnownProviderMark, providerFromSlug } from './provider-from-slug.ts'

test('providerFromSlug keeps compound marks and collapses only into known families', () => {
	expect(isKnownProviderMark('google')).toBe(true)
	expect(isKnownProviderMark('kody')).toBe(false)
	expect(isKnownProviderMark('kody-exchange')).toBe(true)

	expect(providerFromSlug('linkedin')).toBe('linkedin')
	expect(providerFromSlug('google-calendar')).toBe('google')
	expect(providerFromSlug('google-youtube-brand')).toBe('google')
	expect(providerFromSlug('github-kent')).toBe('github')
	expect(providerFromSlug('x-kodykoala')).toBe('x')
	expect(providerFromSlug('kody-exchange')).toBe('kody-exchange')
	expect(providerFromSlug('cal-com')).toBe('cal-com')
	expect(providerFromSlug('my-custom-app')).toBe('my-custom-app')
})
