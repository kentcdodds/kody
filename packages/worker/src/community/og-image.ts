import { ogPalette } from '#worker/og/palette.ts'
import {
	createOgFrame,
	renderOgImage,
	truncateOgText,
	type SatoriElement,
} from '#worker/og/render.ts'

const DESCRIPTION_MAX_LENGTH = 140

/** Amber that reads well on the light surface for filled star icons. */
const STAR_FILLED = '#d97706'

export type CommunityOgImageInput = {
	name: string
	description: string
	ownerUsername: string
	averageStars: number | null
	ratingCount: number
	forkCount: number
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

function createOgMarkup(input: CommunityOgImageInput): SatoriElement {
	const headline = `Use Kody to ${truncateOgText(
		input.description,
		DESCRIPTION_MAX_LENGTH,
	)}`
	const starRow = createStarRow(input)
	const ratingText = formatStarRating(input)

	return createOgFrame({
		label: 'Community package',
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
						color: ogPalette.text,
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
						color: ogPalette.primary,
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
						color: ogPalette.muted,
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
								children: `${input.forkCount} forks`,
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
