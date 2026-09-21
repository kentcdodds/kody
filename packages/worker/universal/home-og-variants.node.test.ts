import { expect, test } from 'vitest'
import { landingPrimitiveIds } from '#universal/landing-lantern.ts'
import {
	absolutizeDocumentHead,
	resolveDocumentHead,
} from '#universal/document-head.ts'
import { publicOgPages } from '#universal/og-pages.ts'
import {
	applyHomeOgVariant,
	getHomeOgVariant,
	homeOgImagePath,
	homeOgVariantIds,
	isHomeOgVariantId,
	locationWithoutHomeOgParam,
	readHomeOgVariant,
	type HomeOgVariantId,
} from './home-og-variants.ts'

const emDash = /[—–]/

test('every locked homepage og key resolves and unknown keys do not', () => {
	expect(homeOgVariantIds).toEqual([
		'switch',
		'cursor-claude',
		'skills',
		'forever',
		'secrets',
		'shared',
		'memory',
		'packages',
		'integrations',
		'apps',
		'triggers',
		'webhooks',
		'email',
		'cron',
		'subscriptions',
	])
	for (const id of homeOgVariantIds) {
		const variant = getHomeOgVariant(id)
		expect(variant?.id).toBe(id)
		expect(variant?.imageTitle).not.toMatch(emDash)
		expect(variant?.imageSubtitle).not.toMatch(emDash)
		expect(variant?.ogTitle).toBe(
			`${variant?.imageTitle.replaceAll('\n', ' ')} · Kody`,
		)
		expect(homeOgImagePath(id)).toBe(`/og/home.png?og=${id}`)
	}
	expect(getHomeOgVariant(null)).toBeNull()
	expect(getHomeOgVariant('')).toBeNull()
	expect(getHomeOgVariant('Triggers')).toBeNull()
	expect(isHomeOgVariantId('not-a-door')).toBe(false)
})

test('lantern keys ring that primitive and triggers doors ring triggers', () => {
	const lantern: Array<HomeOgVariantId> = [
		'memory',
		'packages',
		'integrations',
		'apps',
	]
	for (const id of lantern) {
		expect(getHomeOgVariant(id)?.highlight).toBe(id)
	}
	// secrets is an ICP door that shares the secrets lantern accent.
	expect(getHomeOgVariant('secrets')?.group).toBe('icp')
	expect(getHomeOgVariant('secrets')?.highlight).toBe('secrets')
	for (const id of [
		'triggers',
		'webhooks',
		'email',
		'cron',
		'subscriptions',
	] as const) {
		expect(getHomeOgVariant(id)?.highlight).toBe('triggers')
	}
	for (const id of [
		'switch',
		'cursor-claude',
		'skills',
		'forever',
		'shared',
	] as const) {
		expect(getHomeOgVariant(id)?.highlight).toBeNull()
	}
	for (const variantId of homeOgVariantIds) {
		const highlight = getHomeOgVariant(variantId)?.highlight
		if (highlight) {
			expect(landingPrimitiveIds).toContain(highlight)
		}
	}
})

test('readHomeOgVariant accepts a leading question mark and ignores junk', () => {
	expect(readHomeOgVariant('?og=email&utm_source=youtube')?.id).toBe('email')
	expect(readHomeOgVariant('og=memory')?.id).toBe('memory')
	expect(readHomeOgVariant('?utm_source=youtube')).toBeNull()
	expect(readHomeOgVariant('?og=nope')).toBeNull()
})

test('locationWithoutHomeOgParam drops only og', () => {
	expect(
		locationWithoutHomeOgParam(
			'https://kody.codes/?utm_source=youtube&og=triggers#invite',
		),
	).toBe('/?utm_source=youtube#invite')
	expect(locationWithoutHomeOgParam('https://kody.codes/?og=skills')).toBe('/')
	expect(locationWithoutHomeOgParam('https://kody.codes/#primitives')).toBe(
		null,
	)
	expect(locationWithoutHomeOgParam('not a url')).toBeNull()
})

test('homepage head points og and twitter images at the variant', () => {
	const head = absolutizeDocumentHead(
		resolveDocumentHead('/', undefined, '?og=triggers&utm_source=x'),
		'https://kody.codes',
	)
	expect(head.og?.imageUrl).toBe('https://kody.codes/og/home.png?og=triggers')
	expect(head.og?.title).toBe(getHomeOgVariant('triggers')?.ogTitle)
	expect(head.og?.description).toBe(getHomeOgVariant('triggers')?.imageSubtitle)
	expect(head.canonicalUrl).toBe('https://kody.codes/')

	const fallback = absolutizeDocumentHead(
		resolveDocumentHead('/', undefined, '?og=nope'),
		'https://kody.codes',
	)
	const plain = absolutizeDocumentHead(
		resolveDocumentHead('/'),
		'https://kody.codes',
	)
	expect(fallback.og).toEqual(plain.og)
	expect(plain.og?.imageUrl).toBe('https://kody.codes/og/home.png')
	expect(plain.og?.title).toBe(publicOgPages.home.ogTitle)
})

test('variant copy replaces the homepage card without touching other pages', () => {
	const triggers = getHomeOgVariant('triggers')
	expect(triggers).not.toBeNull()
	if (!triggers) return
	const home = applyHomeOgVariant(publicOgPages.home, triggers)
	expect(home.imageTitle).toBe(triggers.imageTitle)
	expect(home.imageTitle).not.toBe(publicOgPages.home.imageTitle)
	expect(home.path).toBe('/')
})
