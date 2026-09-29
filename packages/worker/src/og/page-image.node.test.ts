import { expect, test } from 'vitest'
import {
	getHomeOgVariant,
	homeOgVariantIds,
} from '#universal/home-og-variants.ts'
import { publicOgPages } from '#universal/og-pages.ts'
import { getOgPalette } from '#worker/og/palette.ts'
import { truncateOgText } from '#worker/og/render.ts'
import {
	ogTitleChildren,
	renderPageOgImage,
	TITLE_MAX_LENGTH,
} from './page-image.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const

function expectPngBytes(png: Uint8Array) {
	expect(png.byteLength).toBeGreaterThan(10_000)
	for (const [index, byte] of PNG_MAGIC.entries()) {
		expect(png[index]).toBe(byte)
	}
}

const render = (
	options: Partial<Parameters<typeof renderPageOgImage>[0]> = {},
) => renderPageOgImage({ page: publicOgPages.home, ...options })
const samePng = (a: Uint8Array, b: Uint8Array) =>
	Buffer.from(a).equals(Buffer.from(b))

test('renderPageOgImage returns valid PNG bytes for home and community', async () => {
	expect.hasAssertions()
	const pngs = await Promise.all([
		render(),
		render({ page: publicOgPages.community }),
		render({ page: publicOgPages.blog }),
		render({ page: publicOgPages.discord }),
		// Same copy as home, Discord path only — so a miss on hero/halo selection
		// cannot hide behind the different title and subtitle.
		render({ page: { ...publicOgPages.home, path: '/discord' } }),
	])
	for (const png of pngs) expectPngBytes(png)
	expect(samePng(pngs[0]!, pngs.at(-1)!)).toBe(false)
})

test('renderPageOgImage renders each theme differently', async () => {
	const light = await render({ theme: 'light' })
	const dark = await render({ theme: 'dark' })
	expectPngBytes(light)
	expectPngBytes(dark)

	// Valid PNG bytes alone would pass even if `theme` were ignored entirely,
	// which is the regression worth catching: the palette, the pattern tint, and
	// the halo all switch on it, so the two encodings cannot coincide.
	expect(samePng(light, dark)).toBe(false)
})

test('homepage og query values render different cards and unknown stays default', async () => {
	const [fallback, unknown, triggers, memory, switchCard, cursorClaude] =
		await Promise.all(
			[undefined, 'nope', 'triggers', 'memory', 'switch', 'cursor-claude'].map(
				(homeOg) => render({ homeOg }),
			),
		)
	const pricingWithQuery = await render({
		page: publicOgPages.pricing,
		homeOg: 'triggers',
	})
	const pricing = await render({ page: publicOgPages.pricing })

	for (const png of [triggers!, memory!, switchCard!, cursorClaude!]) {
		expectPngBytes(png)
	}
	expect(samePng(unknown!, fallback!)).toBe(true)
	expect(samePng(triggers!, fallback!)).toBe(false)
	expect(samePng(triggers!, memory!)).toBe(false)
	expect(samePng(switchCard!, cursorClaude!)).toBe(false)
	expect(samePng(switchCard!, fallback!)).toBe(false)
	expect(samePng(pricingWithQuery, pricing)).toBe(true)
})

test('homepage H1 emphasis is an accent run and plain titles stay a string', () => {
	const accent = getOgPalette('dark').primaryText
	const title = ogTitleChildren({
		text: 'Don\u2019t **start over**\nwith every agent',
		maxLength: TITLE_MAX_LENGTH,
		accent,
	})
	expect(title.lineCount).toBe(2)
	const row = (children: unknown[]) => ({
		type: 'div',
		props: {
			style: { display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' },
			children,
		},
	})
	expect(title.children).toEqual([
		row([
			{ type: 'span', props: { children: 'Don\u2019t\u00A0' } },
			{
				type: 'span',
				props: { style: { color: accent }, children: 'start over' },
			},
		]),
		row([{ type: 'span', props: { children: 'with every agent' } }]),
	])

	expect(
		ogTitleChildren({
			text: 'Public packages',
			maxLength: TITLE_MAX_LENGTH,
			accent,
		}),
	).toEqual({ lineCount: 1, children: 'Public packages' })
})

function collectTitleText(node: unknown): string {
	if (typeof node === 'string') return node
	if (Array.isArray(node)) return node.map(collectTitleText).join('')
	if (node && typeof node === 'object' && 'props' in node) {
		const props = node.props
		if (props && typeof props === 'object' && 'children' in props) {
			return collectTitleText(props.children)
		}
	}
	return ''
}

function emphasisStyles(node: unknown): Array<unknown> {
	if (!node || typeof node !== 'object') return []
	if (Array.isArray(node)) return node.flatMap(emphasisStyles)
	if (!('props' in node)) return []
	const props = node.props
	if (!props || typeof props !== 'object') return []
	const style =
		'style' in props && props.style && typeof props.style === 'object'
			? props.style
			: null
	const nested = 'children' in props ? emphasisStyles(props.children) : []
	return style && 'color' in style ? [style, ...nested] : nested
}

test('emphasized H1 runs keep a space at the colour boundary and fit the title budget', () => {
	const accent = getOgPalette('dark').primaryText
	const titleChildren = (text: string) =>
		ogTitleChildren({ text, maxLength: TITLE_MAX_LENGTH, accent }).children
	const cases = [
		['Don\u2019t **start over**', 'Don\u2019t\u00A0start over'],
		[
			'**Switch** agents. **Keep** the work.',
			'Switch\u00A0agents.\u00A0Keep\u00A0the work.',
		],
		['**Switch **agents', 'Switch\u00A0agents'],
	]
	expect(cases.map(([text]) => collectTitleText(titleChildren(text!)))).toEqual(
		cases.map(([, expected]) => expected),
	)
	for (const style of emphasisStyles(
		titleChildren('Don\u2019t **start over**'),
	)) {
		expect(style).toEqual({ color: accent })
	}

	const titles = [
		publicOgPages.home.imageTitle,
		...homeOgVariantIds.map((id) => getHomeOgVariant(id)?.imageTitle),
	]
	for (const title of titles) {
		expect(title).toBeTruthy()
		if (!title) continue
		expect(truncateOgText(title, TITLE_MAX_LENGTH)).toBe(title)
	}
})
