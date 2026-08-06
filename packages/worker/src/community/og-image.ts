import {
	getOgPalette,
	OG_DEFAULT_THEME,
	type OgPalette,
	type OgTheme,
} from '#worker/og/palette.ts'
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

/**
 * Amber for filled star icons, per theme. The dark value is 2.6:1 on the pale
 * ground — under the 3:1 minimum for a non-text graphic — so light gets a
 * deeper amber at 4.1:1.
 */
const STAR_FILLED = { dark: '#d97706', light: '#b45309' } as const

export type CommunityOgImageInput = {
	/** Card palette; defaults to `OG_DEFAULT_THEME`. */
	theme?: OgTheme
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

function createStarSvg(
	filled: boolean,
	palette: OgPalette,
	theme: OgTheme,
): SatoriElement {
	const starColor = STAR_FILLED[theme]
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
							fill: filled ? starColor : 'transparent',
							stroke: filled ? starColor : palette.border,
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
	const theme = input.theme ?? OG_DEFAULT_THEME
	const palette = getOgPalette(theme)

	const filledCount = Math.max(0, Math.min(5, Math.round(input.averageStars)))
	const stars: Array<SatoriElement> = []

	for (let index = 0; index < 5; index += 1) {
		stars.push(createStarSvg(index < filledCount, palette, theme))
	}

	return stars
}

function createPackageIdentityRow(input: CommunityOgImageInput): SatoriElement {
	const palette = getOgPalette(input.theme)
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
										fontFamily: 'Bricolage Grotesque',
										fontSize: 48,
										fontWeight: 700,
										letterSpacing: '-0.02em',
										color: palette.primary,
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
										color: palette.textMuted,
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
	const palette = getOgPalette(input.theme)
	const description = truncateOgText(input.description, DESCRIPTION_MAX_LENGTH)
	const starRow = createStarRow(input)
	const ratingText = formatStarRating(input)

	return createOgFrame({
		theme: input.theme,
		label: 'Community package',
		children: [
			createPackageIdentityRow(input),
			{
				type: 'div',
				props: {
					style: {
						fontSize: DESCRIPTION_FONT_SIZE,
						lineHeight: DESCRIPTION_LINE_HEIGHT,
						color: palette.textMuted,
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
															color: palette.textMuted,
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
															color: palette.textMuted,
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
									color: palette.textMuted,
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
