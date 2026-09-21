import { expect, test } from 'vitest'
import { landingPrimitiveIds } from '#universal/landing-lantern.ts'
import {
	absolutizeDocumentHead,
	resolveDocumentHead,
} from '#universal/document-head.ts'
import { stripOgEmphasis } from '#universal/og-emphasis.ts'
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

test('share meta uses the locked headlines with markers stripped', () => {
	const locked = {
		switch: {
			imageTitle: '**Switch** agents.\n**Keep** the work.',
			ogTitle: 'Switch agents. Keep the work.',
			subtitle: 'Memory, secrets, and automations that travel with you',
		},
		'cursor-claude': {
			imageTitle: '**Build it**\nwith Cursor.\n**Run it**\nwith Claude.',
			ogTitle: 'Build it with Cursor. Run it with Claude.',
			subtitle: 'One package graph every agent can call',
		},
		skills: {
			imageTitle: 'Turn a skill into\n**software**',
			ogTitle: 'Turn a skill into software',
			subtitle: 'Faster, cheaper, portable, and more reliable',
		},
		forever: {
			imageTitle: 'Say it once.\nRun it **forever**.',
			ogTitle: 'Say it once. Run it forever.',
			subtitle: 'Packages and jobs that don\u2019t need a chat open',
		},
		secrets: {
			imageTitle: '**Secrets**\nyour agents\ncan use, not read',
			ogTitle: 'Secrets your agents can use, not read',
			subtitle: 'The vault stays yours across every host',
		},
		shared: {
			imageTitle: 'The **software**\n**platform** your\nagents share',
			ogTitle: 'The software platform your agents share',
			subtitle: 'One home for memory, packages, and jobs',
		},
		memory: {
			imageTitle: '**Stop**\nre-explaining\nyourself to\nevery agent',
			ogTitle: 'Stop re-explaining yourself to every agent',
			subtitle: 'Shared memory your agents actually use',
		},
		packages: {
			imageTitle: '**Custom software**\nfor your **agents**',
			ogTitle: 'Custom software for your agents',
			subtitle: 'Invoke from your agent, any trigger, or even a custom app',
		},
		integrations: {
			imageTitle: 'Connect the tools\n**once**',
			ogTitle: 'Connect the tools once',
			subtitle: 'One MCP server connects to all of your stuff',
		},
		apps: {
			imageTitle: 'Sometimes you\njust want a **UI**',
			ogTitle: 'Sometimes you just want a UI',
			subtitle: 'The agent builds it for you, it integrates with everything',
		},
		triggers: {
			imageTitle: 'Invoke\ndeterministic\ncode from\n**anything**',
			ogTitle: 'Invoke deterministic code from anything',
			subtitle:
				'Trigger from email, cron, webhooks, events, and even a custom UI',
		},
		webhooks: {
			imageTitle: 'Trigger **anything**\nfrom webhooks',
			ogTitle: 'Trigger anything from webhooks',
			subtitle: 'Connect everything you own with personal software',
		},
		email: {
			imageTitle: 'Run code from\nyour **email**',
			ogTitle: 'Run code from your email',
			subtitle: 'Connect everything you own with personal software',
		},
		cron: {
			imageTitle: 'Put your\nautomations\non a schedule',
			ogTitle: 'Put your automations on a schedule',
			subtitle: 'Connect everything you own with personal software',
		},
		subscriptions: {
			imageTitle: 'Subscribe and\nemit custom\nevents',
			ogTitle: 'Subscribe and emit custom events',
			subtitle: 'Connect everything you own with personal software',
		},
	} as const
	for (const id of homeOgVariantIds) {
		const variant = getHomeOgVariant(id)
		const row = locked[id]
		expect(variant?.imageTitle).toBe(row.imageTitle)
		expect(variant?.imageSubtitle).toBe(row.subtitle)
		expect(variant?.ogTitle).toBe(row.ogTitle)
		expect(variant?.ogDescription).toBe(row.subtitle)
		expect(stripOgEmphasis(row.imageTitle)).toBe(row.ogTitle)
		// Same budget as TITLE_MAX_LENGTH in page-image.ts. Markers and
		// breaks count, so a line that only fits after truncation would
		// lose a word or an emphasis span.
		expect(row.imageTitle.length).toBeLessThanOrEqual(60)
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
	expect(switchHead.og?.title).toBe(locked.switch.ogTitle)
	expect(switchHead.og?.description).toBe(locked.switch.subtitle)
	expect(publicOgPages.home.imageTitle).toBe(
		'Don\u2019t **start over**\nwith every agent',
	)
	expect(publicOgPages.home.ogTitle).toBe(
		'Don\u2019t start over with every agent',
	)
	expect(publicOgPages.home.imageSubtitle).toBe(
		'The software platform your agents share',
	)
	expect(publicOgPages.home.ogDescription).toBe(
		publicOgPages.home.imageSubtitle,
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
