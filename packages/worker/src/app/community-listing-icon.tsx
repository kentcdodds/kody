/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { colors, radius } from '#client/styles/tokens.ts'
import { type PublicCommunityListing } from '#app/community-public-types.ts'

type CommunityListingIconProps = {
	listing: Pick<PublicCommunityListing, 'iconUrl' | 'name'>
	size: 'card' | 'detail'
}

export function CommunityListingIcon(
	handle: Handle<CommunityListingIconProps>,
) {
	const { listing, size } = handle.props
	const dimension = size === 'card' ? 56 : 88
	return () => (
		<span
			mix={css({
				display: 'inline-flex',
				width: dimension,
				height: dimension,
				flex: `0 0 ${dimension}px`,
				overflow: 'hidden',
				alignItems: 'center',
				justifyContent: 'center',
				border: `1px solid ${colors.border}`,
				borderRadius: size === 'card' ? radius.md : radius.lg,
				backgroundColor: colors.surface,
			})}
			data-testid={`community-listing-icon-${size}`}
		>
			<img
				src={listing.iconUrl}
				alt=""
				aria-hidden="true"
				width={dimension}
				height={dimension}
				loading={size === 'card' ? 'lazy' : 'eager'}
				mix={css({
					display: 'block',
					width: '100%',
					height: '100%',
					objectFit: 'contain',
				})}
			/>
		</span>
	)
}
