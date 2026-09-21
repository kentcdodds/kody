import {
	applyHomeOgVariant,
	getHomeOgVariant,
} from '#universal/home-og-variants.ts'
import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'
import { type PublicOgPage } from '#universal/og-pages.ts'
import { createAgentsHero } from '#worker/og/agents-hero.ts'
import { createPrimitivesLantern } from '#worker/og/primitives-lantern.ts'
import { getKodyDiscordDataUri } from '#worker/og/og-image-assets.ts'
import { getOgPalette, type OgTheme } from '#worker/og/palette.ts'
import {
	createOgFrame,
	ensureRenderPipelineReady,
	renderOgImage,
	truncateOgText,
	type OgAssetsFetcher,
	type SatoriElement,
} from '#worker/og/render.ts'

const TITLE_MAX_LENGTH = 60
const SUBTITLE_MAX_LENGTH = 160
const PAGE_TITLE_WIDTH = 580
/** Other pages wrap inside this measure. Home uses the title column so its one-line subtitle fits. */
const PAGE_SUBTITLE_WIDTH = 560

function ogTextLines(text: string, maxLength: number): Array<string> {
	return truncateOgText(text, maxLength)
		.split('\n')
		.filter((line) => line.length > 0)
}

/**
 * A single string lets Satori wrap. Author `\n` breaks become one node per
 * line, which is the only way a hard break survives in this renderer.
 */
function ogTextChildren(
	lines: Array<string>,
): SatoriElement['props']['children'] {
	if (lines.length <= 1) return lines[0] ?? ''
	return lines.map((line) => ({
		type: 'div',
		props: { children: line },
	}))
}

function pageSubtitleMaxWidth(page: PublicOgPage): number {
	// "The software platform your agents share" is 564px at 30px. A 560
	// measure drops "agents share"; the title column keeps it one line.
	return page.path === '/' ? PAGE_TITLE_WIDTH : PAGE_SUBTITLE_WIDTH
}

type PageHeroKind = 'agents' | 'primitives' | 'discord'

function getPageHeroKind(page: PublicOgPage): PageHeroKind {
	if (page.path === '/') return 'primitives'
	if (page.path === '/discord') return 'discord'
	return 'agents'
}

function createHeroHalo(input: {
	kind: PageHeroKind
	theme?: OgTheme
}): SatoriElement | null {
	const isLight = input.theme === 'light'
	switch (input.kind) {
		case 'discord':
			return {
				type: 'div',
				props: {
					style: {
						position: 'absolute',
						// Clyde sits on the right of the pair, a bit higher than
						// the lantern, so the blurple wash follows him instead of
						// the empty middle of the art.
						right: 28,
						top: 88,
						width: 420,
						height: 420,
						borderRadius: 210,
						backgroundImage: isLight
							? 'radial-gradient(circle at center, rgba(88, 101, 242, 0.16) 0%, rgba(88, 101, 242, 0.06) 38%, rgba(88, 101, 242, 0) 72%)'
							: 'radial-gradient(circle at center, rgba(88, 101, 242, 0.38) 0%, rgba(88, 101, 242, 0.14) 38%, rgba(88, 101, 242, 0) 72%)',
					},
				},
			}
		case 'agents':
			// Warm glow is composed inside `createAgentsHero` on the lantern.
			return null
		case 'primitives':
			// The homepage still carries its own orb light.
			return null
		default: {
			const _exhaustive: never = input.kind
			throw new Error(`Unhandled page hero halo: ${_exhaustive}`)
		}
	}
}

function createPageHero(input: {
	kind: PageHeroKind
	theme?: OgTheme
	highlight?: LandingPrimitiveId | null
}): SatoriElement {
	switch (input.kind) {
		case 'discord':
			return {
				type: 'img',
				props: {
					src: getKodyDiscordDataUri(),
					width: 560,
					height: 560,
					style: {
						position: 'absolute',
						// Bled past the frame padding so the art reads as part of
						// the ground rather than an inset picture.
						right: -46,
						// Centred on the whole 630px canvas: the content box starts
						// at the 40px top padding, so (630 - 560) / 2 - 40 = -5.
						top: -5,
						width: 560,
						height: 560,
						objectFit: 'contain',
					},
				},
			}
		case 'agents':
			return createAgentsHero(input.theme ?? 'dark')
		case 'primitives':
			return createPrimitivesLantern(
				input.theme ?? 'dark',
				input.highlight ?? null,
			)
		default: {
			const _exhaustive: never = input.kind
			throw new Error(`Unhandled page hero: ${_exhaustive}`)
		}
	}
}

function createPageOgMarkup(input: {
	page: PublicOgPage
	theme?: OgTheme
	highlight?: LandingPrimitiveId | null
}): SatoriElement {
	const palette = getOgPalette(input.theme)
	const heroKind = getPageHeroKind(input.page)
	const halo = createHeroHalo({ kind: heroKind, theme: input.theme })
	const titleLines = ogTextLines(input.page.imageTitle, TITLE_MAX_LENGTH)
	return createOgFrame({
		theme: input.theme,
		children: {
			type: 'div',
			props: {
				style: {
					width: '100%',
					height: '100%',
					display: 'flex',
					alignItems: 'center',
					position: 'relative',
				},
				children: [
					...(halo ? [halo] : []),
					{
						type: 'div',
						props: {
							style: {
								width: PAGE_TITLE_WIDTH,
								display: 'flex',
								flexDirection: 'column',
								position: 'relative',
							},
							children: [
								{
									type: 'div',
									props: {
										style: {
											fontFamily: 'Bricolage Grotesque',
											fontSize: 78,
											fontWeight: 700,
											lineHeight: 1.0,
											letterSpacing: '-0.03em',
											marginBottom: 24,
											color: palette.text,
											// Satori's default flex row would place hard-broken
											// lines side by side. Single-line titles stay on the
											// default so their wrap is unchanged.
											...(titleLines.length > 1
												? {
														display: 'flex',
														flexDirection: 'column' as const,
													}
												: {}),
										},
										children: ogTextChildren(titleLines),
									},
								},
								{
									type: 'div',
									props: {
										style: {
											maxWidth: pageSubtitleMaxWidth(input.page),
											display: 'flex',
											flexDirection: 'column',
											// Sized and toned for a feed thumbnail rather than a
											// full-size view: see `textReading` in palette.ts.
											fontSize: 30,
											lineHeight: 1.36,
											color: palette.textReading,
										},
										children: ogTextLines(
											input.page.imageSubtitle,
											SUBTITLE_MAX_LENGTH,
										).map((line) => ({
											type: 'div',
											props: { children: line },
										})),
									},
								},
							],
						},
					},
					createPageHero({
						kind: heroKind,
						theme: input.theme,
						highlight: input.highlight,
					}),
				],
			},
		},
	})
}

/**
 * Homepage `?og=` swaps the card copy and, for lantern and triggers doors,
 * rings one orb. Unknown keys and every other page keep the default card.
 */
function resolveRenderedPage(input: {
	page: PublicOgPage
	homeOg?: string | null
}): { page: PublicOgPage; highlight: LandingPrimitiveId | null } {
	if (input.page.path !== '/') {
		return { page: input.page, highlight: null }
	}
	const variant = getHomeOgVariant(input.homeOg)
	if (!variant) return { page: input.page, highlight: null }
	return {
		page: applyHomeOgVariant(input.page, variant),
		highlight: variant.highlight,
	}
}

/** Render the generic OG image for a registered public page. */
export async function renderPageOgImage(input: {
	page: PublicOgPage
	theme?: OgTheme
	assets?: OgAssetsFetcher
	/** Raw `og` query value. Only `/` (the home card) honors it. */
	homeOg?: string | null
}): Promise<Uint8Array<ArrayBuffer>> {
	await ensureRenderPipelineReady({ assets: input.assets })
	const rendered = resolveRenderedPage(input)
	return renderOgImage(
		createPageOgMarkup({
			page: rendered.page,
			theme: input.theme,
			highlight: rendered.highlight,
		}),
		{ assets: input.assets },
	)
}
