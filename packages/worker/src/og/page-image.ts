import { getKodyHeroDataUri } from '#worker/og/og-image-assets.ts'
import { getOgPalette, type OgTheme } from '#worker/og/palette.ts'
import { type PublicOgPage } from '#universal/og-pages.ts'
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

function createPageOgMarkup(input: {
	page: PublicOgPage
	theme?: OgTheme
}): SatoriElement {
	const palette = getOgPalette(input.theme)
	const isLight = input.theme === 'light'
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
					{
						type: 'div',
						props: {
							// Warm halo behind the lantern, centred on where it sits
							// inside the composed art rather than on the art's own
							// centre — Kody holds it low and right of middle. Much
							// weaker on the pale ground: light added to light reads as
							// a dirty smudge rather than a glow.
							style: {
								position: 'absolute',
								right: 52,
								top: 113,
								width: 380,
								height: 380,
								borderRadius: 190,
								backgroundImage: isLight
									? 'radial-gradient(circle at center, rgba(232, 168, 32, 0.16) 0%, rgba(232, 168, 32, 0.06) 38%, rgba(232, 168, 32, 0) 72%)'
									: 'radial-gradient(circle at center, rgba(245, 198, 90, 0.34) 0%, rgba(245, 198, 90, 0.12) 38%, rgba(245, 198, 90, 0) 72%)',
							},
						},
					},
					{
						type: 'div',
						props: {
							style: {
								width: 580,
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
										},
										children: truncateOgText(
											input.page.imageTitle,
											TITLE_MAX_LENGTH,
										),
									},
								},
								{
									type: 'div',
									props: {
										style: {
											maxWidth: 560,
											// Sized and toned for a feed thumbnail rather than a
											// full-size view: see `textReading` in palette.ts.
											fontSize: 30,
											lineHeight: 1.36,
											color: palette.textReading,
										},
										children: truncateOgText(
											input.page.imageSubtitle,
											SUBTITLE_MAX_LENGTH,
										),
									},
								},
							],
						},
					},
					{
						type: 'img',
						props: {
							src: getKodyHeroDataUri(),
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
					},
				],
			},
		},
	})
}

/** Render the generic OG image for a registered public page. */
export async function renderPageOgImage(input: {
	page: PublicOgPage
	theme?: OgTheme
	assets?: OgAssetsFetcher
}): Promise<Uint8Array<ArrayBuffer>> {
	await ensureRenderPipelineReady({ assets: input.assets })
	return renderOgImage(createPageOgMarkup(input), { assets: input.assets })
}
