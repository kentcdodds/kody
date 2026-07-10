import { initWasm, Resvg } from '@resvg/resvg-wasm'
import satori, { init as initSatori } from 'satori/standalone'
import {
	getInterLatin400FontData,
	getInterLatin600FontData,
	ogResvgWasm,
	ogYogaWasm,
} from '#worker/og/og-image-assets.ts'
import { getKodyLogoDataUri } from '#worker/og/logo.ts'
import { OG_CARD_RADIUS, ogPalette } from '#worker/og/palette.ts'

export const OG_WIDTH = 1200
export const OG_HEIGHT = 630

export type SatoriChild = string | SatoriElement
export type SatoriElement = {
	type: string
	props: {
		style?: Record<string, string | number>
		children?: SatoriChild | Array<SatoriChild>
		src?: string
		width?: number
		height?: number
		viewBox?: string
		d?: string
		fill?: string
		stroke?: string
		strokeWidth?: number
	}
}

let renderPipelineReady: Promise<void> | null = null

export function ensureRenderPipelineReady(): Promise<void> {
	if (!renderPipelineReady) {
		renderPipelineReady = Promise.all([
			initSatori(ogYogaWasm),
			initWasm(ogResvgWasm),
		])
			.then(() => undefined)
			.catch((error) => {
				renderPipelineReady = null
				throw error
			})
	}
	return renderPipelineReady
}

export function truncateOgText(text: string, maxLength: number): string {
	const normalized = text.trim().replace(/\s+/g, ' ')
	if (normalized.length <= maxLength) {
		return normalized
	}
	return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

/**
 * Shared 1200×630 frame for all Kody OG images: light app background, a
 * header row with the kody wordmark and a page label, and a surface card
 * that fills the remaining space with the page-specific content.
 */
export function createOgFrame(input: {
	label: string
	children: SatoriChild | Array<SatoriChild>
}): SatoriElement {
	return {
		type: 'div',
		props: {
			style: {
				width: OG_WIDTH,
				height: OG_HEIGHT,
				display: 'flex',
				flexDirection: 'column',
				backgroundColor: ogPalette.background,
				padding: '56px 64px',
				fontFamily: 'Inter',
				color: ogPalette.text,
			},
			children: [
				{
					type: 'div',
					props: {
						style: {
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'space-between',
							marginBottom: 48,
						},
						children: [
							{
								type: 'div',
								props: {
									style: {
										display: 'flex',
										alignItems: 'center',
									},
									children: [
										{
											type: 'img',
											props: {
												src: getKodyLogoDataUri(),
												width: 64,
												height: 64,
												style: {
													width: 64,
													height: 64,
													marginRight: 16,
												},
											},
										},
										{
											type: 'div',
											props: {
												style: {
													fontSize: 44,
													fontWeight: 600,
													letterSpacing: '-0.03em',
													color: ogPalette.primaryText,
												},
												children: 'kody',
											},
										},
									],
								},
							},
							{
								type: 'div',
								props: {
									style: {
										fontSize: 22,
										color: ogPalette.muted,
									},
									children: input.label,
								},
							},
						],
					},
				},
				{
					type: 'div',
					props: {
						style: {
							display: 'flex',
							flex: 1,
							flexDirection: 'column',
							justifyContent: 'center',
							backgroundColor: ogPalette.surface,
							border: `1px solid ${ogPalette.border}`,
							borderRadius: OG_CARD_RADIUS,
							padding: '40px 48px',
						},
						children: input.children,
					},
				},
			],
		},
	}
}

/**
 * Render a Satori markup tree to PNG bytes with the shared font set
 * (Inter 400 for body text, Inter 600 for headings and the wordmark).
 */
export async function renderOgImage(
	markup: SatoriElement,
): Promise<Uint8Array<ArrayBuffer>> {
	await ensureRenderPipelineReady()

	const regularFontData = getInterLatin400FontData()
	const semiboldFontData = getInterLatin600FontData()
	const svg = await satori(markup, {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		fonts: [
			{
				name: 'Inter',
				data: regularFontData,
				weight: 400,
				style: 'normal',
			},
			{
				name: 'Inter',
				data: semiboldFontData,
				weight: 600,
				style: 'normal',
			},
		],
	})

	const resvg = new Resvg(svg, {
		fitTo: { mode: 'width', value: OG_WIDTH },
		font: {
			fontBuffers: [
				new Uint8Array(regularFontData),
				new Uint8Array(semiboldFontData),
			],
			defaultFontFamily: 'Inter',
			sansSerifFamily: 'Inter',
		},
	})
	const rendered = resvg.render()
	const png = rendered.asPng()
	rendered.free()
	resvg.free()

	// asPng returns a fresh ArrayBuffer-backed copy; narrow the generic so
	// callers can pass the bytes straight to Response as BodyInit.
	return png as Uint8Array<ArrayBuffer>
}
