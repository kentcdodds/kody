/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { type PublicCommunityListing } from '#app/community-public.ts'
import {
	communityPackageCategoryCopy,
	countCommunityListingsByCategory,
	visibleCommunityBrowseCategories,
	type CommunityCategoryCounts,
	type CommunityListingCategory,
} from '#universal/community-categories.ts'
import {
	formatCommunityAdaptationEffort,
	formatCommunityPublishedDate,
} from '#universal/community-display.ts'
import { renderCommunityEmptyState } from '#universal/community-empty-state.tsx'
import { CommunityListingIcon } from '#universal/community-listing-icon.tsx'
import {
	FORKED_COPY_TOOLTIP,
	FORK_OUTDATED_COPY_TOOLTIP,
	INSTALLED_COPY_TOOLTIP,
	renderCopyPromptPill,
} from '#universal/fork-outdated-copy-button.tsx'
import { routes } from '#universal/routes.ts'
import { getCommunityListingHref } from '#universal/community-links.ts'
import { renderCommunityListingName } from '#universal/community-listing-name.tsx'
import { communityStatusPillBoxCss } from '#universal/community-status-pill.ts'
import {
	buildCommunityIndexHref,
	defaultCommunityListingSort,
	type CommunityListingSort,
} from '#universal/community-search.ts'
import { type CommunityIndexGroup } from '#universal/loader-data.ts'
import { colors, transitions } from '#universal/styles/tokens.ts'
import {
	getSurfaceCardCss,
	hoverMq,
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
	groups?: Array<CommunityIndexGroup> | null
	categoryCounts?: CommunityCategoryCounts | null
	query: string | null
	sort?: CommunityListingSort
	category?: CommunityListingCategory | null
}

function formatCount(count: number, noun: string) {
	return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function communitySortHint(sort: CommunityListingSort) {
	switch (sort) {
		case 'newest':
			return 'Newest first — last published, including updates.'
		case 'best':
			return 'Best first — ratings, then recency.'
		default: {
			const exhaustive: never = sort
			throw new Error(`Unhandled community listing sort: ${String(exhaustive)}`)
		}
	}
}

function renderCommunityBrowseToolbar(input: {
	query: string | null
	sort: CommunityListingSort
	category: CommunityListingCategory | null
	visibleCategories: Array<CommunityListingCategory>
	showCategoryNav: boolean
	showSort: boolean
}) {
	if (!input.showCategoryNav && !input.showSort) return null
	return (
		<div mix={css(browseToolbarCss)}>
			{input.showCategoryNav ? (
				<nav
					aria-label="Filter community packages by category"
					data-testid="community-listings-categories"
					mix={css(categoryNavCss)}
				>
					<a
						href={buildCommunityIndexHref({
							query: input.query,
							sort: input.sort,
						})}
						aria-current={input.category == null ? 'page' : undefined}
						mix={css(sortLinkCss)}
					>
						All
					</a>
					{input.visibleCategories.map((category) => (
						<a
							key={category}
							href={buildCommunityIndexHref({
								query: input.query,
								sort: input.sort,
								category,
							})}
							aria-current={input.category === category ? 'page' : undefined}
							title={communityPackageCategoryCopy[category].description}
							mix={css(sortLinkCss)}
						>
							{communityPackageCategoryCopy[category].label}
						</a>
					))}
				</nav>
			) : null}
			{input.showSort ? (
				<nav
					aria-label="Sort community packages"
					data-testid="community-listings-sort"
					mix={css(sortToolbarCss)}
				>
					<p mix={css(sortHintCss)}>{communitySortHint(input.sort)}</p>
					<div role="group" aria-label="Sort order" mix={css(sortGroupCss)}>
						<a
							href={buildCommunityIndexHref({
								query: input.query,
								sort: 'best',
								category: input.category,
							})}
							aria-current={input.sort === 'best' ? 'page' : undefined}
							mix={css(sortLinkCss)}
						>
							Best
						</a>
						<a
							href={buildCommunityIndexHref({
								query: input.query,
								sort: 'newest',
								category: input.category,
							})}
							aria-current={input.sort === 'newest' ? 'page' : undefined}
							title="Last published first, including republished updates"
							mix={css(sortLinkCss)}
						>
							Newest
						</a>
					</div>
				</nav>
			) : null}
		</div>
	)
}

function renderCommunityListingCard(
	listing: PublicCommunityListing,
	index: number,
	options?: { showCategory?: boolean },
) {
	return (
		<li
			key={listing.id}
			style={{ '--reveal-delay': `${Math.min(index, 5) * 60}ms` }}
			mix={css(listingCardCss)}
		>
			<div mix={css(listingHeadCss)}>
				<CommunityListingIcon listing={listing} size="card" />
				<div mix={css(listingTitleBlockCss)}>
					<h2 mix={css(listingNameCss)}>
						<a
							href={getCommunityListingHref({
								listingId: listing.id,
								listingName: listing.name,
								kodyId: listing.kodyId,
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
							{renderCommunityViewerInstallBadge({
								listing,
								variant: 'card',
							})}
						</span>
					) : null}
				</div>
			</div>
			<p
				mix={css(listingDescriptionCss)}
				data-testid={`community-listing-description-${listing.id}`}
			>
				{listing.description}
			</p>
			{listing.tags.length > 0 || options?.showCategory ? (
				<ul aria-label="Tags" mix={css(communityTagListCss)}>
					{options?.showCategory ? (
						<li
							data-testid={`community-listing-category-${listing.id}`}
							mix={css(communityTagPillCss)}
						>
							{communityPackageCategoryCopy[listing.category].label}
						</li>
					) : null}
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
				<span
					data-testid={`community-listing-published-${listing.id}`}
					title={`Last published ${formatCommunityPublishedDate(listing.publishedAt)}`}
				>
					<span mix={css(visuallyHiddenCss)}>Published </span>
					{formatCommunityPublishedDate(listing.publishedAt)}
				</span>
				{listing.averageAdaptationEffort == null ? null : (
					<span>
						effort{' '}
						{formatCommunityAdaptationEffort(listing.averageAdaptationEffort)}
					</span>
				)}
			</p>
		</li>
	)
}

function renderCommunityListingGrid(
	listings: Array<PublicCommunityListing>,
	options?: { showCategory?: boolean },
) {
	return (
		<ul mix={css(listingGridCss)}>
			{listings.map((listing, index) =>
				renderCommunityListingCard(listing, index, options),
			)}
		</ul>
	)
}

export function renderCommunityViewerInstallBadge(input: {
	listing: PublicCommunityListing
	variant: 'card' | 'detail'
	loggedIn?: boolean
	returnTo?: string
}) {
	const install = input.listing.viewerInstall
	if (install?.listingAhead && install.listingAheadPrompt) {
		return renderCopyPromptPill({
			label: 'Fork outdated',
			prompt: install.listingAheadPrompt,
			testId:
				input.variant === 'card'
					? `community-listing-ahead-${input.listing.id}`
					: 'community-detail-listing-ahead-badge',
			tooltip: FORK_OUTDATED_COPY_TOOLTIP,
			tone: 'outdated',
		})
	}
	if (install) {
		const installed = install.status === 'installed'
		return renderCopyPromptPill({
			label: installed ? 'Installed' : 'Forked',
			prompt: install.agentPrompt,
			testId:
				input.variant === 'card'
					? `community-listing-viewer-install-${input.listing.id}`
					: 'community-detail-viewer-install-badge',
			tooltip: installed ? INSTALLED_COPY_TOOLTIP : FORKED_COPY_TOOLTIP,
			tone: 'badge',
		})
	}
	if (input.variant !== 'detail') return null
	const loginHref = routes.login.href(null, {
		searchParams: { redirectTo: input.returnTo ?? routes.community.href() },
	})
	if (!input.loggedIn) {
		return (
			<a
				href={loginHref}
				data-testid="community-detail-install"
				data-community-install=""
				mix={css(communityInstallPillCss)}
			>
				Install
			</a>
		)
	}
	return (
		<button
			type="button"
			data-testid="community-detail-install"
			data-community-install=""
			data-trusted={input.listing.trusted ? 'true' : 'false'}
			mix={css(communityInstallPillCss)}
		>
			Install
		</button>
	)
}

export function CommunityListingsContent(
	handle: Handle<CommunityListingsContentProps>,
) {
	const { listings, query } = handle.props
	const sort = handle.props.sort ?? defaultCommunityListingSort
	const category = handle.props.category ?? null
	const groups = handle.props.groups ?? null
	const categoryCounts =
		handle.props.categoryCounts ?? countCommunityListingsByCategory(listings)
	const visibleCategories = visibleCommunityBrowseCategories({
		counts: categoryCounts,
		selected: category,
	})
	const emptyCatalog =
		listings.length === 0 && query == null && category == null
	const showCategoryNav = visibleCategories.length > 0 || category != null
	const showSort = !emptyCatalog

	return () => (
		<div data-testid="community-listings-frame">
			{renderCommunityBrowseToolbar({
				query,
				sort,
				category,
				visibleCategories,
				showCategoryNav,
				showSort,
			})}
			{listings.length === 0 ? (
				renderCommunityEmptyState(query, sort, category)
			) : groups != null && groups.length > 0 ? (
				<div data-testid="community-listings-overview" mix={css(overviewCss)}>
					{groups.map((group) => {
						const label = communityPackageCategoryCopy[group.category].label
						const hasMore = group.total > group.listings.length
						return (
							<section
								key={group.category}
								aria-labelledby={`community-category-${group.category}`}
								mix={css(overviewSectionCss)}
							>
								<header mix={css(overviewHeadCss)}>
									<div>
										<h2
											id={`community-category-${group.category}`}
											mix={css(overviewTitleCss)}
										>
											{label}
										</h2>
										<p mix={css(overviewHintCss)}>
											{communityPackageCategoryCopy[group.category].description}
										</p>
									</div>
									{hasMore ? (
										<a
											href={buildCommunityIndexHref({
												query,
												sort,
												category: group.category,
											})}
											mix={css(overviewSeeAllCss)}
										>
											See all {label}
										</a>
									) : null}
								</header>
								{renderCommunityListingGrid(group.listings)}
							</section>
						)
					})}
				</div>
			) : (
				renderCommunityListingGrid(listings, { showCategory: query != null })
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

const browseToolbarCss = {
	margin: 'clamp(2.2rem, 5vw, 3.5rem) 0 0',
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.9rem',
}

const categoryNavCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: '0.4rem',
	'& a': {
		backgroundColor: colors.surface,
		border: `1.5px solid ${colors.border}`,
		borderRadius: '999px',
		padding: '0.35rem 0.85rem',
	},
}

const sortToolbarCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: '0.8rem 1.2rem',
	flexWrap: 'wrap' as const,
}

const overviewCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	gap: 'clamp(1.8rem, 4vw, 2.6rem)',
	marginTop: '1rem',
}

const overviewSectionCss = {
	minWidth: 0,
}

const overviewHeadCss = {
	display: 'flex',
	alignItems: 'flex-end',
	justifyContent: 'space-between',
	gap: '0.8rem 1.2rem',
	flexWrap: 'wrap' as const,
	marginBottom: '0.85rem',
}

const overviewTitleCss = {
	margin: 0,
	fontSize: '1.15rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
}

const overviewHintCss = {
	margin: '0.25rem 0 0',
	color: colors.textMuted,
	fontSize: '0.88rem',
}

const overviewSeeAllCss = {
	color: colors.primaryText,
	fontSize: '0.9rem',
	fontWeight: 650,
	textUnderlineOffset: '0.18em',
	whiteSpace: 'nowrap' as const,
}

const sortHintCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
}

const sortGroupCss = {
	display: 'inline-flex',
	alignItems: 'stretch',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: '999px',
	padding: '0.2rem',
}

const sortLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	minHeight: '2rem',
	padding: '0.3rem 0.95rem',
	borderRadius: '999px',
	color: colors.textMuted,
	fontSize: '0.88rem',
	fontWeight: 650,
	lineHeight: 1.2,
	textDecoration: 'none',
	transition: `background-color 140ms ${transitions.easeOut}, color 140ms ${transitions.easeOut}`,
	'&:hover': {
		color: colors.text,
	},
	'&[aria-current="page"]': {
		backgroundColor: colors.primarySoft,
		color: colors.primaryText,
	},
}

const listingGridCss = {
	listStyle: 'none',
	margin: '1rem 0 0',
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
	alignItems: 'flex-start',
	gap: '0.7rem',
}

const listingTitleBlockCss = {
	minWidth: 0,
	flex: 1,
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.4rem',
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
   the card's trailing-edge push. Same box as Install / Installed. */
export const communityBadgePillCss = {
	...communityStatusPillBoxCss,
	color: colors.primaryText,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.13)`,
	cursor: 'help',
}

export const communityInstallPillCss = {
	...communityBadgePillCss,
	appearance: 'none' as const,
	textDecoration: 'none',
	cursor: 'pointer',
	[hoverMq]: {
		'&:hover': {
			backgroundColor: `oklch(from ${colors.primary} l c h / 0.2)`,
			color: colors.primaryText,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
}

const listingBadgeGroupCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.35rem',
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
