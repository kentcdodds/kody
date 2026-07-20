import { ogPalette } from '#worker/og/palette.ts'
import {
	createOgFrame,
	renderOgImage,
	truncateOgText,
	type SatoriElement,
} from '#worker/og/render.ts'

/** Character clamp for the supporting bio (~2 visual lines). */
const BIO_MAX_LENGTH = 140
const BIO_FONT_SIZE = 28
const BIO_LINE_HEIGHT = 1.4
/** Hard visual clamp so long text cannot overrun the stats row. */
const BIO_MAX_HEIGHT = Math.round(BIO_FONT_SIZE * BIO_LINE_HEIGHT * 2)
const AVATAR_SIZE = 96

export type ProfileOgImageInput = {
	displayName: string
	username: string
	bio: string | null
	followerCount: number
	publicPackageCount: number
	listingCount: number
	/** User avatar as a data URI (PNG or JPEG) for satori, or null for placeholder. */
	avatarDataUri: string | null
}

function pluralize(count: number, singular: string, plural: string) {
	return `${count} ${count === 1 ? singular : plural}`
}

function formatProfileStats(input: ProfileOgImageInput): string {
	return [
		pluralize(input.followerCount, 'follower', 'followers'),
		pluralize(input.publicPackageCount, 'public package', 'public packages'),
		pluralize(input.listingCount, 'community listing', 'community listings'),
	].join(' · ')
}

function createAvatarPlaceholder(displayName: string): SatoriElement {
	const initial = (displayName.trim().charAt(0) || '?').toUpperCase()
	return {
		type: 'div',
		props: {
			style: {
				width: AVATAR_SIZE,
				height: AVATAR_SIZE,
				borderRadius: AVATAR_SIZE / 2,
				marginRight: 24,
				backgroundColor: ogPalette.primary,
				color: ogPalette.onPrimary,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				fontSize: 40,
				fontWeight: 600,
			},
			children: initial,
		},
	}
}

function createAvatarNode(input: ProfileOgImageInput): SatoriElement {
	if (!input.avatarDataUri) {
		return createAvatarPlaceholder(input.displayName)
	}

	return {
		type: 'img',
		props: {
			src: input.avatarDataUri,
			width: AVATAR_SIZE,
			height: AVATAR_SIZE,
			style: {
				width: AVATAR_SIZE,
				height: AVATAR_SIZE,
				borderRadius: AVATAR_SIZE / 2,
				marginRight: 24,
				objectFit: 'cover',
			},
		},
	}
}

function createProfileIdentityRow(input: ProfileOgImageInput): SatoriElement {
	return {
		type: 'div',
		props: {
			style: {
				display: 'flex',
				alignItems: 'center',
				marginBottom: 28,
			},
			children: [
				createAvatarNode(input),
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
									children: input.displayName,
								},
							},
							{
								type: 'div',
								props: {
									style: {
										fontSize: 24,
										color: ogPalette.muted,
									},
									children: `@${input.username}`,
								},
							},
						],
					},
				},
			],
		},
	}
}

function createOgMarkup(input: ProfileOgImageInput): SatoriElement {
	const bio =
		input.bio == null || input.bio.trim() === ''
			? null
			: truncateOgText(input.bio, BIO_MAX_LENGTH)

	return createOgFrame({
		label: 'Community profile',
		children: [
			createProfileIdentityRow(input),
			...(bio
				? [
						{
							type: 'div',
							props: {
								style: {
									fontSize: BIO_FONT_SIZE,
									lineHeight: BIO_LINE_HEIGHT,
									color: ogPalette.muted,
									marginBottom: 28,
									maxHeight: BIO_MAX_HEIGHT,
									overflow: 'hidden',
								},
								children: bio,
							},
						} satisfies SatoriElement,
					]
				: []),
			{
				type: 'div',
				props: {
					style: {
						fontSize: 22,
						color: ogPalette.muted,
					},
					children: formatProfileStats(input),
				},
			},
		],
	})
}

export async function renderProfileOgImage(
	input: ProfileOgImageInput,
): Promise<Uint8Array<ArrayBuffer>> {
	return renderOgImage(createOgMarkup(input))
}
