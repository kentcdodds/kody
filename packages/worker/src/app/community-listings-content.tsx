/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { type PublicCommunityListing } from '#app/community-public.ts'
import { formatCommunityAdaptationEffort } from '#universal/community-display.ts'
import { CommunityListingIcon } from '#universal/community-listing-icon.tsx'
import { renderCommunityListingName } from '#universal/community-listing-name.tsx'
import { routes } from '#universal/routes.ts'
import { colors, transitions } from '#universal/styles/tokens.ts'
import {
	getSurfaceCardCss,
	mergeCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Server-rendered community listings (the `community-listings` frame),
 * restyled to the redesign prototype's `.pkg-grid` / `.pkg-card` grammar
 * (`landing/community.html`). This HTML is injected by the frame mechanism —
 * no client component hydrates here, so the card entrance is a pure CSS
 * animation (gated on `html.js` + reduced-motion) that replays whenever the
 * frame loads or reloads, with a per-card stagger set inline by the server.
 */

export type CommunityListingsContentProps = {
	listings: Array<PublicCommunityListing>
	query: string | null
}

function formatCount(count: number, noun: string) {
	return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function CommunityListingsContent(
	handle: Handle<CommunityListingsContentProps>,
) {
	const { listings, query } = handle.props

	return () => (
		<div data-testid="community-listings-frame">
			{listings.length === 0 ? (
				<p mix={css(emptyStateCss)}>
					{query
						? 'No community packages matched your search.'
						: 'No community packages have been published yet.'}
				</p>
			) : (
				<ul mix={css(listingGridCss)}>
					{listings.map((listing, index) => (
						<li
							key={listing.id}
							style={{ '--reveal-delay': `${Math.min(index, 5) * 60}ms` }}
							mix={css(listingCardCss)}
						>
							<div mix={css(listingHeadCss)}>
								<CommunityListingIcon listing={listing} size="card" />
								<h2 mix={css(listingNameCss)}>
									<a
										href={routes.communityDetail.href({
											listingId: listing.id,
										})}
										mix={css(listingLinkCss)}
									>
										{renderCommunityListingName(listing.name)}
									</a>
								</h2>
								{listing.trusted || listing.viewerInstall ? (
									<span mix={css(listingBadgeGroupCss)}>
										{listing.trusted ? (
											<span
												data-testid={`community-listing-trusted-${listing.id}`}
												title="An admin reviewed this exact version and marked it trusted."
												mix={css(communityBadgePillCss)}
											>
												Trusted
											</span>
										) : null}
										{listing.viewerInstall ? (
											<span
												data-testid={`community-listing-viewer-install-${listing.id}`}
												title={
													listing.viewerInstall.status === 'installed'
														? `Installed in your account as ${listing.viewerInstall.targetName}.`
														: `Forked in your account as ${listing.viewerInstall.targetName}; still needs adaptation.`
												}
												mix={css(communityBadgePillCss)}
											>
												{listing.viewerInstall.status === 'installed'
													? 'Installed'
													: 'Forked'}
											</span>
										) : null}
									</span>
								) : null}
							</div>
							<p
								mix={css(listingDescriptionCss)}
								data-testid={`community-listing-description-${listing.id}`}
							>
								{listing.description}
							</p>
							{listing.tags.length > 0 ? (
								<ul aria-label="Tags" mix={css(communityTagListCss)}>
									{listing.tags.map((tag) => (
										<li key={tag} mix={css(communityTagPillCss)}>
											{tag}
										</li>
									))}
								</ul>
							) : null}
							<p mix={css(statsCss)}>
								{listing.ratingCount > 0 ? (
									/*
									 * Every other stat in this row says what it is
									 * ("12 forks", "5 stars", "effort …"), but the
									 * rating is a glyph and two bare numbers, which
									 * announced as "black star 4.5 (12)". The glyph is
									 * decorative and the numbers get a spoken label.
									 */
									<span mix={css(ratingCss)}>
										<span aria-hidden="true" mix={css(ratingStarCss)}>
											★
										</span>
										<span mix={css(visuallyHiddenCss)}>
											{listing.averageStars == null
												? `not yet rated, ${formatCount(listing.ratingCount, 'rating')}`
												: `rated ${listing.averageStars.toFixed(1)} out of 5 from ${formatCount(listing.ratingCount, 'rating')}`}
										</span>
										<span aria-hidden="true">
											{' '}
											{listing.averageStars == null
												? '—'
												: listing.averageStars.toFixed(1)}{' '}
											({listing.ratingCount})
										</span>
									</span>
								) : (
									<span>No ratings yet</span>
								)}
								<span data-testid={`community-listing-forks-${listing.id}`}>
									{formatCount(listing.forkCount, 'fork')}
								</span>
								<span data-testid={`community-listing-stars-${listing.id}`}>
									{formatCount(listing.starCount, 'star')}
								</span>
								{listing.averageAdaptationEffort == null ? null : (
									<span>
										effort{' '}
										{formatCommunityAdaptationEffort(
											listing.averageAdaptationEffort,
										)}
									</span>
								)}
							</p>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

export async function renderCommunityListingsContentHtml(
	props: CommunityListingsContentProps,
) {
	return renderToString(<CommunityListingsContent {...props} />)
}

/* ---------- styles ---------- */

const emptyStateCss = {
	margin: 'clamp(2.2rem, 5vw, 3.5rem) 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}

const listingGridCss = {
	listStyle: 'none',
	margin: 'clamp(2.2rem, 5vw, 3.5rem) 0 0',
	padding: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(min(19rem, 100%), 1fr))',
	gap: '1rem',
}

/* Surface card with green hover border + lift; whole card is the target via
   the stretched name link. Entrance reuses the shared `card-in` keyframes
   from public/styles.css (declared inside the same reduced-motion media
   block), staggered by the inline `--reveal-delay`. */
const listingCardCss = mergeCss(getSurfaceCardCss({ interactive: true }), {
	position: 'relative' as const,
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.8rem',
	padding: '1.3rem 1.4rem',
	'@media (prefers-reduced-motion: no-preference)': {
		':root.js &': {
			animation: `card-in 600ms ${transitions.easeOut} var(--reveal-delay, 0ms) backwards`,
		},
	},
})

const listingHeadCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.7rem',
}

const listingNameCss = {
	margin: 0,
	fontSize: '1.12rem',
	fontWeight: 720,
	letterSpacing: '-0.012em',
	lineHeight: 1.2,
	overflowWrap: 'anywhere' as const,
	minWidth: 0,
}

/* The whole card is the target; the link just names it. */
const listingLinkCss = {
	color: colors.text,
	textDecoration: 'none',
	transition: `color 140ms ${transitions.easeOut}`,
	'&:hover': {
		color: colors.primaryText,
	},
	'&::after': {
		content: '""',
		position: 'absolute' as const,
		inset: 0,
	},
}

/* The prototype's `.badge-trusted` pill; the detail head reuses it without
   the card's trailing-edge push. */
export const communityBadgePillCss = {
	flex: 'none',
	fontSize: '0.78rem',
	fontWeight: 650,
	color: colors.primaryText,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.13)`,
	borderRadius: '999px',
	padding: '0.15rem 0.6rem',
	whiteSpace: 'nowrap' as const,
	cursor: 'help',
}

const listingBadgeGroupCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.35rem',
	marginLeft: 'auto',
	flex: 'none',
}

const listingDescriptionCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.95rem',
	lineHeight: 1.55,
	textWrap: 'balance' as const,
}

/* Hairline tag chips (`.pkg-tags`), shared with the detail head. */
export const communityTagListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.35rem',
}

export const communityTagPillCss = {
	fontSize: '0.8rem',
	fontWeight: 550,
	color: colors.textMuted,
	border: `1px solid ${colors.border}`,
	borderRadius: '999px',
	padding: '0.1rem 0.6rem',
}

/* Stats sit on the card floor, over a top hairline. */
const statsCss = {
	margin: 'auto 0 0',
	paddingTop: '0.8rem',
	borderTop: `1px solid ${colors.border}`,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.3rem 1.1rem',
	fontSize: '0.88rem',
	color: colors.textMuted,
	'& span': {
		whiteSpace: 'nowrap' as const,
	},
}

const ratingCss = {
	color: colors.text,
	fontWeight: 600,
}

const ratingStarCss = {
	color: colors.primaryText,
}
