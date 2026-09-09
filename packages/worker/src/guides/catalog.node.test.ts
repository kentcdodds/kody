import { expect, test } from 'vitest'
import {
	getGuideById,
	getGuideBySlug,
	getIntroGuide,
	guides,
	listGuides,
	listGuidesBySection,
	listPlatformGuides,
	listProviderGuides,
	toGuideSummary,
} from './catalog.ts'
import { parseDocumentHeadings } from './document-sections.ts'
import {
	docsIntroSlug,
	docsNav,
	isReservedDocsIndexSlug,
	legacyDocSlugAliases,
	legacyGuideIdAliases,
	listDocsNavSlugs,
	unadvertisedDocSlugs,
} from '#universal/docs-nav.ts'

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
		// catalog rewrites them to /docs routes or GitHub blob URLs.
		expect(guide.body).not.toMatch(/\]\(\.{1,2}\//)
		expect(guide.body).not.toMatch(/\]\([a-z0-9-]+\.md/)
		expect(guide.body).not.toContain('](/guides/')
		expect(isReservedDocsIndexSlug(guide.slug)).toBe(false)
		expect(getGuideBySlug(guide.slug)?.id).toBe(guide.id)
		expect(getGuideById(guide.id)?.slug).toBe(guide.slug)
	}
	for (const guide of guides.filter((g) => g.category === 'provider')) {
		expect(guide.provider).toBeTruthy()
		expect(guide.lastVerified).toMatch(/^\d{4}-\d{2}$/)
		expect(guide.id.startsWith('provider_')).toBe(true)
	}

	expect(getGuideById('locked_gmail_drafts')).toMatchObject({
		image: '/images/kody-gmail-drafts-lock.webp',
		ogImage: '/images/kody-gmail-drafts-lock-og.jpg',
	})

	expect(getGuideById('package_apps')).toMatchObject({
		slug: 'package-apps',
		title: 'Package apps',
	})

	expect(getGuideById('values')?.unadvertised).toBe(true)
	expect(listGuides().some((guide) => guide.id === 'values')).toBe(false)
	expect(getGuideById('package_invocation_token_setup')?.unadvertised).toBe(
		true,
	)
	expect(
		listGuides().some((guide) => guide.id === 'package_invocation_token_setup'),
	).toBe(false)
	expect(getGuideBySlug('connect')).toBeNull()

	// Web ordering follows the docs nav: provider docs sit together in one
	// section, sorted by provider name.
	const listed = listGuides()
	const providers = listed
		.filter((guide) => guide.category === 'provider')
		.map((guide) => guide.provider ?? '')
	expect(providers).toEqual(
		[...providers].toSorted((a, b) => a.localeCompare(b)),
	)
	const providerIndexes = listed
		.map((guide, index) => (guide.category === 'provider' ? index : -1))
		.filter((index) => index !== -1)
	expect(providerIndexes).toEqual(
		providerIndexes.map((_, offset) => providerIndexes[0]! + offset),
	)

	expect(
		listPlatformGuides().every((guide) => guide.category === 'platform'),
	).toBe(true)
	expect(listProviderGuides().map((guide) => guide.provider)).toEqual(providers)

	expect(getGuideBySlug('llms.txt')).toBeNull()
})

test('docs nav covers every advertised doc exactly once and nothing else', () => {
	const navSlugs = listDocsNavSlugs()
	expect(new Set(navSlugs).size).toBe(navSlugs.length)
	expect(navSlugs[0]).toBe(docsIntroSlug)
	expect(getIntroGuide().slug).toBe(docsIntroSlug)

	const advertised = listGuides().map((guide) => guide.slug)
	expect([...navSlugs].toSorted()).toEqual([...advertised].toSorted())
	for (const slug of unadvertisedDocSlugs) {
		expect(getGuideBySlug(slug)?.unadvertised).toBe(true)
	}

	for (const section of docsNav) {
		expect(section.items.length).toBeGreaterThan(0)
		for (const item of section.items) {
			expect(item.label.length).toBeGreaterThan(0)
			expect(getGuideBySlug(item.slug)).not.toBeNull()
		}
	}
	const providerSection = docsNav.find((section) => section.id === 'providers')
	expect(
		providerSection?.items.map((item) => getGuideBySlug(item.slug)?.category),
	).toEqual(providerSection?.items.map(() => 'provider'))
	expect(
		docsNav
			.filter((section) => section.id !== 'providers')
			.flatMap((section) => section.items)
			.every((item) => getGuideBySlug(item.slug)?.category === 'platform'),
	).toBe(true)

	const grouped = listGuidesBySection()
	expect(grouped.map(({ section }) => section.id)).toEqual(
		docsNav.map((section) => section.id),
	)
	expect(grouped.flatMap(({ guides }) => guides.map((g) => g.slug))).toEqual(
		navSlugs,
	)
	for (const guide of listGuides()) {
		expect(toGuideSummary(guide).section).not.toBeNull()
	}
	expect(toGuideSummary(getGuideBySlug('values')!).section).toBeNull()
})

test('agent playbooks are marked and merged docs keep resolving through aliases', () => {
	for (const slug of [
		'onboarding',
		'quick-example',
		'portability',
		'first-win',
	]) {
		expect(getGuideBySlug(slug)?.audience).toBe('agents')
	}
	expect(getGuideBySlug('what-is-kody')?.audience).toBe('everyone')
	expect(getGuideBySlug('memory')?.category).toBe('platform')

	for (const [oldSlug, alias] of Object.entries(legacyDocSlugAliases)) {
		expect(getGuideBySlug(oldSlug)).toBeNull()
		const target = getGuideBySlug(alias.slug)
		expect(target).not.toBeNull()
		if (alias.fragment) {
			// The fragment must match a heading the absorbing doc actually has.
			const headings = parseDocumentHeadings(target!.body).map(
				(heading) => heading.slug,
			)
			expect(headings).toContain(alias.fragment)
		}
	}
	for (const [oldId, alias] of Object.entries(legacyGuideIdAliases)) {
		expect(getGuideById(oldId)).toBeNull()
		expect(getGuideById(alias.id)).not.toBeNull()
	}
})
