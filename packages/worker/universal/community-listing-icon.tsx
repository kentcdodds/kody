/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { colors } from '#universal/styles/tokens.ts'
import { type PublicCommunityListing } from '#universal/community-public-types.ts'

type CommunityListingIconProps = {
	listing: Pick<PublicCommunityListing, 'iconUrl' | 'name'>
	size: 'card' | 'starter' | 'detail'
}

/** Well geometry per context (prototype `.pkg-icon` / `.starter-card img` / `.pkg-icon-lg`). */
const iconWellBySize = {
	card: { size: '2.4rem', radius: '10px', borderWidth: '1px' },
	starter: { size: '3.2rem', radius: '12px', borderWidth: '1px' },
	detail: { size: '3.6rem', radius: '14px', borderWidth: '1.5px' },
} as const

/**
 * Per-package icon in a rounded well (the prototype's `.pkg-icon` /
 * `.pkg-icon-lg` grammar). The image is served per pinned commit by the
 * community icon endpoint, which already falls back to a rendered initial
 * when a package publishes no icon — so the well always has a photo to fill.
 */
export function CommunityListingIcon(
	handle: Handle<CommunityListingIconProps>,
) {
	const { listing, size } = handle.props
	const well = iconWellBySize[size]
	const isDetail = size === 'detail'
	return () => (
		<span
			mix={css({
				flex: 'none',
				display: 'block',
				width: well.size,
				height: well.size,
				borderRadius: well.radius,
				backgroundColor: isDetail ? colors.surface : colors.background,
				border: `${well.borderWidth} solid ${colors.border}`,
				overflow: 'hidden',
				boxSizing: 'border-box' as const,
			})}
			data-testid={`community-listing-icon-${size}`}
		>
			<img
				src={listing.iconUrl}
				alt=""
				aria-hidden="true"
				width={isDetail ? 88 : 56}
				height={isDetail ? 88 : 56}
				loading={isDetail ? 'eager' : 'lazy'}
				mix={css({
					display: 'block',
					width: '100%',
					height: '100%',
					// `contain`, not `cover`: the icon endpoint serves raster
					// icons at their source dimensions, so a wide logo would be
					// center-cropped. The generated square fallback fills the
					// well identically either way.
					objectFit: 'contain',
				})}
			/>
		</span>
	)
}
