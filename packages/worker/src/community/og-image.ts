import { initWasm, Resvg } from '@resvg/resvg-wasm'
import satori, { init as initSatori } from 'satori/standalone'
import {
	communityOgResvgWasm,
	communityOgYogaWasm,
	getInterLatin400FontData,
} from '#worker/community/og-image-assets.ts'

const OG_WIDTH = 1200
const OG_HEIGHT = 630
const DESCRIPTION_MAX_LENGTH = 140

const palette = {
	background: '#0b0b0c',
	panel: '#141417',
	border: '#2a2a30',
	text: '#f3f4f6',
	muted: '#9ca3af',
	accent: '#d4a574',
	starFilled: '#e8b84b',
	starEmpty: '#3f3f46',
	wordmark: '#e5e7eb',
} as const

export type CommunityOgImageInput = {
	name: string
	description: string
	ownerUsername: string
	averageStars: number | null
	ratingCount: number
	forkCount: number
}

type SatoriChild = string | SatoriElement
type SatoriElement = {
	type: string
	props: {
		style?: Record<string, string | number>
		children?: SatoriChild | Array<SatoriChild>
		width?: number
		height?: number
		viewBox?: string
		d?: string
		fill?: string
		stroke?: string
		strokeWidth?: number
	}
}

const STAR_PATH =
	'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'

let renderPipelineReady: Promise<void> | null = null

function ensureRenderPipelineReady(): Promise<void> {
	if (!renderPipelineReady) {
		renderPipelineReady = Promise.all([
			initSatori(communityOgYogaWasm),
			initWasm(communityOgResvgWasm),
		])
			.then(() => undefined)
			.catch((error) => {
				renderPipelineReady = null
				throw error
			})
	}
	return renderPipelineReady
}

function truncateDescription(description: string): string {
	const normalized = description.trim().replace(/\s+/g, ' ')
	if (normalized.length <= DESCRIPTION_MAX_LENGTH) {
		return normalized
	}
	return `${normalized.slice(0, DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`
}

function formatStarRating(input: CommunityOgImageInput): string {
	if (input.averageStars === null || input.ratingCount === 0) {
		return 'No ratings yet'
	}
	const formattedAverage = input.averageStars.toFixed(1)
	const ratingLabel = input.ratingCount === 1 ? 'rating' : 'ratings'
	return `${formattedAverage} (${input.ratingCount} ${ratingLabel})`
}

function createStarSvg(filled: boolean): SatoriElement {
	return {
		type: 'div',
		props: {
			style: {
				width: 22,
				height: 22,
				marginRight: 4,
				display: 'flex',
			},
			children: {
				type: 'svg',
				props: {
					width: 22,
					height: 22,
					viewBox: '0 0 24 24',
					children: {
						type: 'path',
						props: {
							d: STAR_PATH,
							fill: filled ? palette.starFilled : 'transparent',
							stroke: filled ? palette.starFilled : palette.starEmpty,
							strokeWidth: 1.5,
						},
					},
				},
			},
		},
	}
}

function createStarRow(input: CommunityOgImageInput): Array<SatoriElement> {
	if (input.averageStars === null || input.ratingCount === 0) {
		return []
	}

	const filledCount = Math.max(0, Math.min(5, Math.round(input.averageStars)))
	const stars: Array<SatoriElement> = []

	for (let index = 0; index < 5; index += 1) {
		stars.push(createStarSvg(index < filledCount))
	}

	return stars
}

function createOgMarkup(input: CommunityOgImageInput): SatoriElement {
	const headline = `Use Kody to ${truncateDescription(input.description)}`
	const starRow = createStarRow(input)
	const ratingText = formatStarRating(input)

	return {
		type: 'div',
		props: {
			style: {
				width: OG_WIDTH,
				height: OG_HEIGHT,
				display: 'flex',
				flexDirection: 'column',
				backgroundColor: palette.background,
				padding: '56px 64px',
				fontFamily: 'Inter',
				color: palette.text,
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
										fontSize: 44,
										fontWeight: 600,
										letterSpacing: '-0.03em',
										color: palette.wordmark,
									},
									children: 'kody',
								},
							},
							{
								type: 'div',
								props: {
									style: {
										fontSize: 22,
										color: palette.muted,
									},
									children: 'Community package',
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
							backgroundColor: palette.panel,
							border: `1px solid ${palette.border}`,
							borderRadius: 24,
							padding: '40px 48px',
						},
						children: [
							{
								type: 'div',
								props: {
									style: {
										fontSize: 42,
										fontWeight: 600,
										lineHeight: 1.2,
										letterSpacing: '-0.02em',
										marginBottom: 28,
									},
									children: headline,
								},
							},
							{
								type: 'div',
								props: {
									style: {
										fontSize: 30,
										fontWeight: 600,
										color: palette.accent,
										marginBottom: 20,
									},
									children: input.name,
								},
							},
							{
								type: 'div',
								props: {
									style: {
										fontSize: 24,
										color: palette.muted,
										marginBottom: 28,
									},
									children: `by @${input.ownerUsername}`,
								},
							},
							{
								type: 'div',
								props: {
									style: {
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'space-between',
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
													...(starRow.length > 0
														? starRow
														: [
																{
																	type: 'div',
																	props: {
																		style: {
																			fontSize: 22,
																			color: palette.muted,
																		},
																		children: ratingText,
																	},
																},
															]),
													...(starRow.length > 0
														? [
																{
																	type: 'div',
																	props: {
																		style: {
																			fontSize: 22,
																			color: palette.muted,
																			marginLeft: 12,
																		},
																		children: ratingText,
																	},
																},
															]
														: []),
												],
											},
										},
										{
											type: 'div',
											props: {
												style: {
													fontSize: 22,
													color: palette.muted,
												},
												children: `${input.forkCount} forks`,
											},
										},
									],
								},
							},
						],
					},
				},
			],
		},
	}
}

export async function renderCommunityOgImage(
	input: CommunityOgImageInput,
): Promise<Uint8Array> {
	await ensureRenderPipelineReady()

	const fontData = getInterLatin400FontData()
	const svg = await satori(createOgMarkup(input), {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		fonts: [
			{
				name: 'Inter',
				data: fontData,
				weight: 400,
				style: 'normal',
			},
		],
	})

	const resvg = new Resvg(svg, {
		fitTo: { mode: 'width', value: OG_WIDTH },
		font: {
			fontBuffers: [new Uint8Array(fontData)],
			defaultFontFamily: 'Inter',
			sansSerifFamily: 'Inter',
		},
	})
	const rendered = resvg.render()
	const png = rendered.asPng()
	rendered.free()
	resvg.free()

	return png
}
