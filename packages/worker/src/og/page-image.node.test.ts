import { expect, test } from 'vitest'
import {
	getHomeOgVariant,
	homeOgVariantIds,
} from '#universal/home-og-variants.ts'
import { parseOgEmphasis } from '#universal/og-emphasis.ts'
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

test('renderPageOgImage returns valid PNG bytes for home and community', async () => {
	expect.hasAssertions()
	const home = await renderPageOgImage({ page: publicOgPages.home })
	expectPngBytes(home)

	const community = await renderPageOgImage({ page: publicOgPages.community })
	expectPngBytes(community)

	const blog = await renderPageOgImage({ page: publicOgPages.blog })
	expectPngBytes(blog)

	const discord = await renderPageOgImage({ page: publicOgPages.discord })
	expectPngBytes(discord)

	// Same copy as home, Discord path only — so a miss on hero/halo selection
	// cannot hide behind the different title and subtitle.
	const homeWithDiscordHero = await renderPageOgImage({
		page: { ...publicOgPages.home, path: '/discord' },
	})
	expectPngBytes(homeWithDiscordHero)
	expect(Buffer.from(home).equals(Buffer.from(homeWithDiscordHero))).toBe(false)
})

test('renderPageOgImage renders each theme differently', async () => {
	const light = await renderPageOgImage({
		page: publicOgPages.home,
		theme: 'light',
	})
	const dark = await renderPageOgImage({
		page: publicOgPages.home,
		theme: 'dark',
	})
	expectPngBytes(light)
	expectPngBytes(dark)

	// Valid PNG bytes alone would pass even if `theme` were ignored entirely,
	// which is the regression worth catching: the palette, the pattern tint, and
	// the halo all switch on it, so the two encodings cannot coincide.
	expect(Buffer.from(light).equals(Buffer.from(dark))).toBe(false)
})

test('homepage og query values render different cards and unknown stays default', async () => {
	const fallback = await renderPageOgImage({ page: publicOgPages.home })
	const unknown = await renderPageOgImage({
		page: publicOgPages.home,
		homeOg: 'nope',
	})
	const triggers = await renderPageOgImage({
		page: publicOgPages.home,
		homeOg: 'triggers',
	})
	const memory = await renderPageOgImage({
		page: publicOgPages.home,
		homeOg: 'memory',
	})
	const pricingWithQuery = await renderPageOgImage({
		page: publicOgPages.pricing,
		homeOg: 'triggers',
	})
	const pricing = await renderPageOgImage({ page: publicOgPages.pricing })

	expectPngBytes(triggers)
	expectPngBytes(memory)
	expect(Buffer.from(unknown).equals(Buffer.from(fallback))).toBe(true)
	expect(Buffer.from(triggers).equals(Buffer.from(fallback))).toBe(false)
	expect(Buffer.from(triggers).equals(Buffer.from(memory))).toBe(false)

	const switchCard = await renderPageOgImage({
		page: publicOgPages.home,
		homeOg: 'switch',
	})
	const cursorClaude = await renderPageOgImage({
		page: publicOgPages.home,
		homeOg: 'cursor-claude',
	})
	expectPngBytes(switchCard)
	expectPngBytes(cursorClaude)
	expect(Buffer.from(switchCard).equals(Buffer.from(cursorClaude))).toBe(false)
	expect(Buffer.from(switchCard).equals(Buffer.from(fallback))).toBe(false)
	expect(Buffer.from(pricingWithQuery).equals(Buffer.from(pricing))).toBe(true)
})

test('homepage H1 emphasis is an accent run and plain titles stay a string', () => {
	const accent = getOgPalette('dark').primaryText
	const title = ogTitleChildren({
		text: 'Don\u2019t **start over**\nwith every agent',
		maxLength: TITLE_MAX_LENGTH,
		accent,
	})
	expect(title.lineCount).toBe(2)
	expect(title.children).toEqual([
		{
			type: 'div',
			props: {
				style: {
					display: 'flex',
					flexDirection: 'row',
					flexWrap: 'nowrap',
				},
				children: [
					{ type: 'span', props: { children: 'Don\u2019t\u00A0' } },
					{
						type: 'span',
						props: { style: { color: accent }, children: 'start over' },
					},
				],
			},
		},
		{
			type: 'div',
			props: {
				style: {
					display: 'flex',
					flexDirection: 'row',
					flexWrap: 'nowrap',
				},
				children: [{ type: 'span', props: { children: 'with every agent' } }],
			},
		},
	])

	const plain = ogTitleChildren({
		text: 'Public packages',
		maxLength: TITLE_MAX_LENGTH,
		accent,
	})
	expect(plain).toEqual({ lineCount: 1, children: 'Public packages' })
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

function boundarySpacesAsNbsp(line: string): string {
	return parseOgEmphasis(line)
		.map((run) =>
			run.text.replace(/^ +| +$/g, (spaces) => '\u00A0'.repeat(spaces.length)),
		)
		.join('')
}

test('emphasized H1 runs keep a space at the colour boundary', () => {
	const accent = getOgPalette('dark').primaryText
	const titles = [
		publicOgPages.home.imageTitle,
		...homeOgVariantIds.map((id) => getHomeOgVariant(id)?.imageTitle),
	]
	for (const title of titles) {
		if (!title?.includes('**')) continue
		for (const line of title.split('\n')) {
			if (!line.includes('**')) continue
			const painted = ogTitleChildren({
				text: line,
				maxLength: TITLE_MAX_LENGTH,
				accent,
			})
			expect(collectTitleText(painted.children)).toBe(
				boundarySpacesAsNbsp(line),
			)
			for (const style of emphasisStyles(painted.children)) {
				expect(style).toEqual({ color: accent })
			}
		}
	}

	expect(
		collectTitleText(
			ogTitleChildren({
				text: 'Don\u2019t **start over**',
				maxLength: TITLE_MAX_LENGTH,
				accent,
			}).children,
		),
	).toBe('Don\u2019t\u00A0start over')
	expect(
		collectTitleText(
			ogTitleChildren({
				text: '**Switch** agents. **Keep** the work.',
				maxLength: TITLE_MAX_LENGTH,
				accent,
			}).children,
		),
	).toBe('Switch\u00A0agents.\u00A0Keep\u00A0the work.')
	expect(
		collectTitleText(
			ogTitleChildren({
				text: '**Switch **agents',
				maxLength: TITLE_MAX_LENGTH,
				accent,
			}).children,
		),
	).toBe('Switch\u00A0agents')
})

test('locked homepage headlines fit the title budget without an ellipsis', () => {
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
