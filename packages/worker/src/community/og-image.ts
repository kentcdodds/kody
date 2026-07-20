import { ogPalette } from '#worker/og/palette.ts'
import {
	createOgFrame,
	renderOgImage,
	truncateOgText,
	type SatoriElement,
} from '#worker/og/render.ts'

/** Character clamp for the supporting description (~2 visual lines). */
const DESCRIPTION_MAX_LENGTH = 95
const DESCRIPTION_FONT_SIZE = 28
const DESCRIPTION_LINE_HEIGHT = 1.4
/** Hard visual clamp so long text cannot overrun ratings/forks. */
const DESCRIPTION_MAX_HEIGHT = Math.round(
	DESCRIPTION_FONT_SIZE * DESCRIPTION_LINE_HEIGHT * 2,
)
const PACKAGE_ICON_SIZE = 96
/** Matches `--radius-lg` (0.75rem) at OG canvas scale (~1.5× UI). */
const PACKAGE_ICON_RADIUS = 18

/** Amber that reads well on the light surface for filled star icons. */
const STAR_FILLED = '#d97706'

export type CommunityOgImageInput = {
	name: string
	description: string
	ownerUsername: string
	averageStars: number | null
	ratingCount: number
	forkCount: number
	starCount: number
	/** Package community icon as a data URI (PNG or JPEG) for satori. */
	iconDataUri: string
}

function formatForkAndStarCounts(input: CommunityOgImageInput): string {
	const starLabel = input.starCount === 1 ? 'star' : 'stars'
	const forkLabel = input.forkCount === 1 ? 'fork' : 'forks'
	return `${input.starCount} ${starLabel} · ${input.forkCount} ${forkLabel}`
}

const STAR_PATH =
	'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'

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
							fill: filled ? STAR_FILLED : 'transparent',
							stroke: filled ? STAR_FILLED : ogPalette.border,
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

function createPackageIdentityRow(input: CommunityOgImageInput): SatoriElement {
	return {
		type: 'div',
		props: {
			style: {
				display: 'flex',
				alignItems: 'center',
				marginBottom: 28,
			},
			children: [
				{
					type: 'img',
					props: {
						src: input.iconDataUri,
						width: PACKAGE_ICON_SIZE,
						height: PACKAGE_ICON_SIZE,
						style: {
							width: PACKAGE_ICON_SIZE,
							height: PACKAGE_ICON_SIZE,
							borderRadius: PACKAGE_ICON_RADIUS,
							marginRight: 24,
							objectFit: 'contain',
						},
					},
				},
				{
					type: 'div',
					props: {
						style: {
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'center',
						},
						children: [
							{
								type: 'div',
								props: {
									style: {
										fontSize: 48,
										fontWeight: 600,
										letterSpacing: '-0.02em',
										color: ogPalette.primary,
										marginBottom: 8,
									},
									children: input.name,
								},
							},
							{
								type: 'div',
								props: {
									style: {
										fontSize: 24,
										color: ogPalette.muted,
									},
									children: `by @${input.ownerUsername}`,
								},
							},
						],
					},
				},
			],
		},
	}
}

function createOgMarkup(input: CommunityOgImageInput): SatoriElement {
	const description = truncateOgText(input.description, DESCRIPTION_MAX_LENGTH)
	const starRow = createStarRow(input)
	const ratingText = formatStarRating(input)

	return createOgFrame({
		label: 'Community package',
		children: [
			createPackageIdentityRow(input),
			{
				type: 'div',
				props: {
					style: {
						fontSize: DESCRIPTION_FONT_SIZE,
						lineHeight: DESCRIPTION_LINE_HEIGHT,
						color: ogPalette.muted,
						marginBottom: 28,
						maxHeight: DESCRIPTION_MAX_HEIGHT,
						overflow: 'hidden',
					},
					children: description,
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
															color: ogPalette.muted,
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
															color: ogPalette.muted,
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
									color: ogPalette.muted,
								},
								children: formatForkAndStarCounts(input),
							},
						},
					],
				},
			},
		],
	})
}

export async function renderCommunityOgImage(
	input: CommunityOgImageInput,
): Promise<Uint8Array<ArrayBuffer>> {
	return renderOgImage(createOgMarkup(input))
}
