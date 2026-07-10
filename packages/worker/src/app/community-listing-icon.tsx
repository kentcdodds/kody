/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { radius, spacing } from '#client/styles/tokens.ts'
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
				alignItems: 'center',
				justifyContent: 'center',
				margin: size === 'card' ? spacing.xs : spacing.sm,
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
					borderRadius: size === 'card' ? radius.md : radius.lg,
					objectFit: 'contain',
				})}
			/>
		</span>
	)
}
