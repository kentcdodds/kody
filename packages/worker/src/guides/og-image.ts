import { getOgPalette, type OgTheme } from '#worker/og/palette.ts'
import {
	createOgFrame,
	ensureRenderPipelineReady,
	renderOgImage,
	truncateOgText,
	type OgAssetsFetcher,
	type SatoriElement,
} from '#worker/og/render.ts'

const TITLE_MAX_LENGTH = 70
const DESCRIPTION_MAX_LENGTH = 180

export type GuideOgImageInput = {
	title: string
	description: string
	imageDataUri: string
	theme?: OgTheme
}

function createGuideOgMarkup(input: GuideOgImageInput): SatoriElement {
	const palette = getOgPalette(input.theme)
	return createOgFrame({
		theme: input.theme,
		label: 'Guide',
		children: {
			type: 'div',
			props: {
				style: {
					width: '100%',
					height: '100%',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: 48,
				},
				children: [
					{
						type: 'div',
						props: {
							style: {
								width: 610,
								display: 'flex',
								flexDirection: 'column',
							},
							children: [
								{
									type: 'div',
									props: {
										style: {
											fontFamily: 'Bricolage Grotesque',
											fontSize: 60,
											fontWeight: 700,
											lineHeight: 1.05,
											letterSpacing: '-0.025em',
											marginBottom: 24,
											color: palette.text,
										},
										children: truncateOgText(input.title, TITLE_MAX_LENGTH),
									},
								},
								{
									type: 'div',
									props: {
										style: {
											fontSize: 28,
											lineHeight: 1.38,
											color: palette.textReading,
										},
										children: truncateOgText(
											input.description,
											DESCRIPTION_MAX_LENGTH,
										),
									},
								},
							],
						},
					},
					{
						type: 'img',
						props: {
							src: input.imageDataUri,
							width: 430,
							height: 430,
							style: {
								width: 430,
								height: 430,
								objectFit: 'cover',
								borderRadius: 28,
								border: `2px solid ${palette.border}`,
							},
						},
					},
				],
			},
		},
	})
}

export async function renderGuideOgImage(
	input: GuideOgImageInput & { assets?: OgAssetsFetcher },
): Promise<Uint8Array<ArrayBuffer>> {
	await ensureRenderPipelineReady({ assets: input.assets })
	return renderOgImage(createGuideOgMarkup(input), { assets: input.assets })
}
