import { expect, test } from 'vitest'
import { getGuideById, getGuideBySlug, guides, listGuides } from './catalog.ts'

test('guide catalog parses every guide with unique ids and slugs', () => {
	expect(guides.length).toBeGreaterThanOrEqual(12)

	const ids = guides.map((guide) => guide.id)
	const slugs = guides.map((guide) => guide.slug)
	expect(new Set(ids).size).toBe(ids.length)
	expect(new Set(slugs).size).toBe(slugs.length)

	for (const guide of guides) {
		expect(guide.title.length).toBeGreaterThan(0)
		expect(guide.summary.length).toBeGreaterThan(0)
		expect(guide.body.length).toBeGreaterThan(200)
		// Bundled bodies must not carry unresolvable relative links; the
		// catalog rewrites them to /guides routes or GitHub blob URLs.
		expect(guide.body).not.toMatch(/\]\(\.{1,2}\//)
		expect(guide.body).not.toMatch(/\]\([a-z0-9-]+\.md/)
	}
	for (const guide of guides.filter((g) => g.category === 'provider')) {
		expect(guide.provider).toBeTruthy()
		expect(guide.lastVerified).toMatch(/^\d{4}-\d{2}$/)
		expect(guide.id.startsWith('provider_')).toBe(true)
	}

	const oauth = getGuideBySlug('oauth')
	expect(oauth?.id).toBe('oauth')
	expect(getGuideById('connect_secret')?.slug).toBe('account-secret-setup')
	expect(getGuideBySlug('how-kody-works')?.id).toBe('how_kody_works')
	expect(getGuideById('how_kody_works')?.slug).toBe('how-kody-works')
	expect(getGuideBySlug('google-oauth')?.id).toBe('google_oauth')
	expect(getGuideById('google_oauth')?.slug).toBe('google-oauth')

	// Web ordering: platform guides first, then provider guides sorted by
	// provider name.
	const listed = listGuides()
	const categories = listed.map((guide) => guide.category)
	expect(categories).toEqual(
		[...categories].toSorted((a, b) =>
			a === b ? 0 : a === 'platform' ? -1 : 1,
		),
	)
	const providers = listed
		.filter((guide) => guide.category === 'provider')
		.map((guide) => guide.provider ?? '')
	expect(providers).toEqual(
		[...providers].toSorted((a, b) => a.localeCompare(b)),
	)
})
