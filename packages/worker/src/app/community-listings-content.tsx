/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { type PublicCommunityListing } from '#app/community-public.ts'
import {
	formatCommunityAdaptationEffort,
	formatCommunityStars,
} from '#app/community-display.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import { cardCss, descriptionCss } from '#client/styles/style-primitives.ts'

export type CommunityListingsContentProps = {
	listings: Array<PublicCommunityListing>
	query: string | null
}

export function CommunityListingsContent(
	handle: Handle<CommunityListingsContentProps>,
) {
	const { listings, query } = handle.props

	return () => (
		<div data-testid="community-listings-frame">
			{listings.length === 0 ? (
				<p mix={css(descriptionCss)}>
					{query
						? 'No community packages matched your search.'
						: 'No community packages have been published yet.'}
				</p>
			) : (
				<div mix={css(listingGridCss)}>
					{listings.map((listing) => (
						<article key={listing.id} mix={css(cardCss)}>
							<h2
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
								})}
							>
								<a
									href={`/community/${listing.id}`}
									mix={css({
										color: colors.primaryText,
										textDecoration: 'none',
									})}
								>
									{listing.name}
								</a>
							</h2>
							<p
								mix={css(descriptionCss)}
								data-testid={`community-listing-description-${listing.id}`}
							>
								{listing.description}
							</p>
							{listing.tags.length > 0 ? (
								<ul mix={css(tagListCss)}>
									{listing.tags.map((tag) => (
										<li key={tag} mix={css(tagPillCss)}>
											{tag}
										</li>
									))}
								</ul>
							) : null}
							<dl mix={css(statsCss)}>
								<div>
									<dt>Rating</dt>
									<dd>
										{formatCommunityStars(
											listing.averageStars,
											listing.ratingCount,
										)}
									</dd>
								</div>
								<div>
									<dt>Forks</dt>
									<dd data-testid={`community-listing-forks-${listing.id}`}>
										{listing.forkCount}
									</dd>
								</div>
								<div>
									<dt>Adaptation effort</dt>
									<dd>
										{formatCommunityAdaptationEffort(
											listing.averageAdaptationEffort,
										)}
									</dd>
								</div>
							</dl>
						</article>
					))}
				</div>
			)}
		</div>
	)
}

export async function renderCommunityListingsContentHtml(
	props: CommunityListingsContentProps,
) {
	return renderToString(<CommunityListingsContent {...props} />)
}

const listingGridCss = {
	display: 'grid',
	gap: spacing.lg,
	gridTemplateColumns: 'repeat(auto-fit, minmax(18rem, 1fr))',
	[mq.mobile]: {
		gridTemplateColumns: '1fr',
	},
}

const tagListCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.xs,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}

const tagPillCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
	fontSize: typography.fontSize.sm,
}

const statsCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
	gap: spacing.sm,
	margin: 0,
	fontSize: typography.fontSize.sm,
	'& dt': {
		margin: 0,
		color: colors.textMuted,
		fontWeight: typography.fontWeight.medium,
	},
	'& dd': {
		margin: `${spacing.xs} 0 0`,
		color: colors.text,
	},
}
