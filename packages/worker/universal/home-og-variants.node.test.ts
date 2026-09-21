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
		expect(variant?.ogTitle).toBe(variant?.imageTitle)
		expect(variant?.ogDescription).toBe(variant?.imageSubtitle)
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

test('share meta uses Marley locked headlines with no extra suffix', () => {
	const locked = {
		switch: [
			'Switch agents. Keep the work.',
			'Memory, secrets, and packages that travel with you',
		],
		'cursor-claude': [
			'Built in Cursor. Run it in Claude.',
			'One package graph every agent can call',
		],
		skills: [
			'Turn a skill into software you own',
			'Save it once. Invoke it from any MCP host',
		],
		forever: [
			'Say it once. Run it forever.',
			"Packages and jobs that don't need a chat open",
		],
		secrets: [
			'Secrets your agents can use, not read',
			'The vault stays yours across every host',
		],
		shared: [
			'The software platform your agents share',
			'One home for memory, packages, and jobs',
		],
		memory: [
			'Stop re-explaining yourself to every agent',
			'Shared memory your agents actually use',
		],
		packages: ['Own the answer as a package', 'Invoke it from any MCP host'],
		integrations: [
			'Connect the tools. Keep the software',
			'Integrations your packages call, not chat glue',
		],
		apps: [
			'Your agents share a real app surface',
			'Connect services. Keep the software',
		],
		triggers: [
			'When it fires, your package runs',
			'Email, cron, and webhooks into software you own',
		],
		webhooks: [
			'Events in. Owned software out.',
			'Webhooks that wake packages you control',
		],
		email: [
			'When the email lands, the package runs',
			'Mail that starts work \u2014 not another inbox tab',
		],
		cron: [
			'Say it once. Run it on a schedule.',
			'Jobs that keep going with no chat open',
		],
		subscriptions: [
			'When the subscription fires, the package runs',
			'Stripe and billing events into software you own',
		],
	} as const
	for (const id of homeOgVariantIds) {
		const variant = getHomeOgVariant(id)
		expect(variant?.imageTitle).toBe(locked[id][0])
		expect(variant?.imageSubtitle).toBe(locked[id][1])
		expect(variant?.ogTitle).toBe(locked[id][0])
		expect(variant?.ogDescription).toBe(locked[id][1])
	}
	const switchHead = absolutizeDocumentHead(
		resolveDocumentHead('/', undefined, '?og=switch'),
		'https://kody.codes',
	)
	const cursorHead = absolutizeDocumentHead(
		resolveDocumentHead('/', undefined, '?og=cursor-claude'),
		'https://kody.codes',
	)
	expect(switchHead.og?.imageUrl).toBe(
		'https://kody.codes/og/home.png?og=switch',
	)
	expect(cursorHead.og?.imageUrl).toBe(
		'https://kody.codes/og/home.png?og=cursor-claude',
	)
	expect(switchHead.og?.imageUrl).not.toBe(cursorHead.og?.imageUrl)
	expect(switchHead.og?.title).toBe(locked.switch[0])
	expect(switchHead.og?.description).toBe(locked.switch[1])
	expect(publicOgPages.home.imageTitle).toContain("Don't start over")
	expect(publicOgPages.home.imageSubtitle).toBe(
		'The software platform your agents share',
	)
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
