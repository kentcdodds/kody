/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { type PublicCommunityListing } from '#app/community-public.ts'
import { communityPackageCategoryCopy } from '#universal/community-categories.ts'
import { buildCommunityIndexHref } from '#universal/community-search.ts'
import {
	formatCommunityAdaptationEffort,
	formatCommunityPublishedDate,
	formatCommunityStars,
	shortCommunityCommit,
} from '#universal/community-display.ts'
import { CommunityListingIcon } from '#universal/community-listing-icon.tsx'
import { renderCommunityListingName } from '#universal/community-listing-name.tsx'
import {
	communityBadgePillCss,
	communityTagListCss,
	communityTagPillCss,
	renderCommunityViewerInstallBadge,
} from '#app/community-listings-content.tsx'
import { renderProfileFollowControl } from '#app/profile-follow-control.tsx'
import { getCommunityPackageFilesHref } from '#universal/package-files.ts'
import { routes } from '#universal/routes.ts'
import { visuallyHiddenCss } from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

/**
 * Server-rendered community detail head (the `community-detail` frame),
 * restyled to the redesign prototype's `.pkg-detail` grammar
 * (`landing/community-detail.html`): back link → icon + name + author +
 * badges → description → hairline tag chips → quiet dt/dd meta row between
 * hairlines. The page-open `data-rise` choreography is pure CSS keyed on
 * `html.js` + reduced-motion, so this frame HTML animates on every load or
 * reload without any client component hydrating here.
 */

export type CommunityDetailContentProps = {
	listing: PublicCommunityListing | null
	ownerProfilePublic: boolean
	loggedIn: boolean
	starredByViewer: boolean
	viewerFollowsOwner: boolean
	viewerIsOwner: boolean
	returnTo: string
	followError: string | null
}

export function CommunityDetailContent(
	handle: Handle<CommunityDetailContentProps>,
) {
	const {
		listing,
		ownerProfilePublic,
		loggedIn,
		starredByViewer,
		viewerFollowsOwner,
		viewerIsOwner,
		returnTo,
		followError,
	} = handle.props

	if (!listing) {
		return () => null
	}

	return () => (
		<div data-testid="community-detail-frame">
			<a
				data-rise
				style={{ '--rise': '0' }}
				href={routes.community.href()}
				mix={css(backLinkCss)}
			>
				← Public packages
			</a>

			<header data-rise style={{ '--rise': '1' }} mix={css(detailHeadCss)}>
				<CommunityListingIcon listing={listing} size="detail" />
				<div mix={css(headTextCss)}>
					<div mix={css(titleRowCss)}>
						<h1>{renderCommunityListingName(listing.name)}</h1>
						{renderCommunityDetailStarControl({
							listingName: listing.name,
							loggedIn,
							starred: starredByViewer,
							returnTo,
						})}
					</div>
					<span mix={css(detailBadgeGroupCss)}>
						{listing.sourceAhead ? (
							<span
								data-testid="community-detail-source-ahead-badge"
								title="Default-branch HEAD is newer than the last package publish. Source at HEAD is already public; runtime still uses the published commit."
								mix={css(badgeCss)}
							>
								HEAD ahead of published
							</span>
						) : null}
						{listing.featured ? (
							<span
								data-testid="community-detail-featured-badge"
								title="An admin featured this package as an onboarding starter install."
								mix={css(badgeCss)}
							>
								Featured
							</span>
						) : null}
						{renderCommunityViewerInstallBadge({
							listing,
							variant: 'detail',
							loggedIn,
							returnTo,
							viewerIsOwner,
						})}
					</span>
					{/* A div, not a p: the signed-in follow control is a form, and
					    browsers close a p before a form, which drops the glyph
					    onto the next line. Separate flex items (not nested flex +
					    trailing space) so "by" / @username / follow stay inline. */}
					<div
						mix={css(ownerLineCss)}
						data-testid="community-detail-owner-line"
					>
						<span>by</span>
						{ownerProfilePublic ? (
							<a
								href={routes.profile.href({
									username: listing.ownerUsername,
								})}
								mix={css(ownerLinkCss)}
							>
								@{listing.ownerUsername}
							</a>
						) : (
							<span mix={css(ownerPrivateNameCss)}>
								@{listing.ownerUsername}
								<span
									data-testid="community-detail-owner-private"
									title="This profile is private"
									mix={css(ownerPrivateLockCss)}
								>
									<svg
										viewBox="0 0 16 16"
										width="0.9em"
										height="0.9em"
										aria-hidden="true"
										focusable={false}
										fill="none"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<rect x="3.5" y="7.2" width="9" height="6.3" rx="1.4" />
										<path d="M5.4 7.2V5.4a2.6 2.6 0 0 1 5.2 0v1.8" />
									</svg>
									<span mix={css(visuallyHiddenCss)}>
										This profile is private
									</span>
								</span>
							</span>
						)}
						{ownerProfilePublic && !viewerIsOwner
							? renderProfileFollowControl({
									username: listing.ownerUsername,
									loggedIn,
									isFollowing: viewerFollowsOwner,
									returnTo,
									followError,
									testId: 'community-detail-owner-follow',
									errorTestId: 'community-detail-owner-follow-error',
								})
							: null}
					</div>
				</div>
			</header>

			<p data-rise style={{ '--rise': '2' }} mix={css(detailSubCss)}>
				{listing.description}
			</p>
			<p data-rise style={{ '--rise': '2' }} mix={css(filesLinkRowCss)}>
				<a
					href={getCommunityPackageFilesHref({
						listingId: listing.id,
						ownerUsername: listing.ownerUsername,
						kodyId: listing.kodyId,
					})}
					data-testid="community-browse-files"
					mix={css(filesLinkCss)}
				>
					Browse files
				</a>
			</p>

			<ul
				data-rise
				style={{ '--rise': '3' }}
				aria-label="Category and tags"
				mix={css(detailTagListCss)}
			>
				<li mix={css(communityTagPillCss)}>
					<a
						href={buildCommunityIndexHref({ category: listing.category })}
						data-testid="community-listing-category"
						mix={css(detailCategoryLinkCss)}
					>
						{communityPackageCategoryCopy[listing.category].label}
					</a>
				</li>
				{listing.tags.map((tag) => (
					<li key={tag} mix={css(communityTagPillCss)}>
						{tag}
					</li>
				))}
			</ul>

			{/* Facts as a quiet definition row, not a stat billboard. */}
			<dl data-rise style={{ '--rise': '4' }} mix={css(metaCss)}>
				<div>
					<dt>License</dt>
					<dd>{listing.license}</dd>
				</div>
				<div>
					<dt>Published</dt>
					<dd>{formatCommunityPublishedDate(listing.publishedAt)}</dd>
				</div>
				<div>
					<dt>Pinned commit</dt>
					<dd>
						<code>{shortCommunityCommit(listing.pinnedCommit)}</code>
					</dd>
				</div>
				<div>
					<dt>Rating</dt>
					<dd data-testid="community-detail-rating">
						{formatCommunityStars(listing.averageStars, listing.ratingCount)}
					</dd>
				</div>
				<div>
					<dt>Forks</dt>
					<dd data-testid="community-detail-forks">{listing.forkCount}</dd>
				</div>
				<div>
					<dt>Stars</dt>
					<dd data-testid="community-detail-stars" data-community-star-count="">
						{listing.starCount}
					</dd>
				</div>
				<div>
					<dt>Adaptation effort</dt>
					<dd>
						{formatCommunityAdaptationEffort(listing.averageAdaptationEffort)}
					</dd>
				</div>
			</dl>
		</div>
	)
}

export async function renderCommunityDetailContentHtml(
	props: CommunityDetailContentProps,
) {
	return renderToString(<CommunityDetailContent {...props} />)
}

function renderCommunityDetailStarControl(input: {
	listingName: string
	loggedIn: boolean
	starred: boolean
	returnTo: string
}) {
	const label = input.starred
		? `Unstar ${input.listingName}`
		: `Star ${input.listingName}`
	const glyph = renderCommunityStarGlyph()
	if (!input.loggedIn) {
		const loginHref = routes.login.href(null, {
			searchParams: { redirectTo: input.returnTo },
		})
		return (
			<a
				href={loginHref}
				title="Star"
				data-testid="community-detail-star"
				data-community-star=""
				mix={css(starButtonCss)}
			>
				{glyph}
				<span mix={css(visuallyHiddenCss)}>{label}</span>
			</a>
		)
	}
	return (
		<button
			type="button"
			title={input.starred ? 'Unstar' : 'Star'}
			data-testid="community-detail-star"
			data-community-star=""
			data-starred={input.starred ? 'true' : 'false'}
			data-listing-name={input.listingName}
			mix={css(starButtonCss)}
		>
			{glyph}
			<span data-community-star-label="" mix={css(visuallyHiddenCss)}>
				{label}
			</span>
		</button>
	)
}

function renderCommunityStarGlyph() {
	return (
		<svg
			viewBox="0 0 16 16"
			width="1em"
			height="1em"
			aria-hidden="true"
			focusable={false}
			fill="none"
			stroke="currentColor"
			strokeWidth={1.4}
			strokeLinejoin="round"
		>
			<path d="M8 1.7 9.9 6.1l4.7.4-3.6 3.1 1.1 4.6L8 11.8l-4.1 2.4 1.1-4.6-3.6-3.1 4.7-.4z" />
		</svg>
	)
}

/* ---------- styles (prototype: `.pkg-detail` in landing/styles.css) ---------- */

const backLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.4rem',
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}

const detailHeadCss = {
	marginTop: '1.8rem',
	display: 'flex',
	alignItems: 'flex-start',
	gap: '1.1rem',
}

const headTextCss = {
	minWidth: 0,
	flex: 1,
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.45rem',
	'& h1': {
		margin: 0,
		fontSize: 'clamp(1.7rem, 4vw, 2.4rem)',
		fontWeight: 760,
		letterSpacing: '-0.024em',
		lineHeight: 1.05,
		overflowWrap: 'anywhere' as const,
	},
}

const titleRowCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.5rem',
	minWidth: 0,
	'& h1': {
		flex: '0 1 auto',
		minWidth: 0,
	},
}

const starButtonCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '1.85rem',
	height: '1.85rem',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: '999px',
	backgroundColor: 'transparent',
	color: colors.textMuted,
	textDecoration: 'none',
	cursor: 'pointer',
	flexShrink: 0,
	'&:hover': {
		color: colors.primaryText,
		borderColor: colors.primaryText,
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
	'& svg': {
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: 1.4,
	},
	'&[data-starred="true"]': {
		color: colors.primary,
		borderColor: colors.primary,
		backgroundColor: `oklch(from ${colors.primary} l c h / 0.13)`,
		'& svg': {
			fill: 'currentColor',
			strokeWidth: 0,
		},
		'&:hover': {
			color: colors.primaryText,
			borderColor: colors.primaryText,
			backgroundColor: `oklch(from ${colors.primary} l c h / 0.2)`,
		},
	},
}

const detailBadgeGroupCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.35rem',
}

const ownerLineCss = {
	display: 'inline-flex',
	alignItems: 'center',
	flexWrap: 'nowrap' as const,
	gap: '0.35rem',
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.95rem',
	width: 'max-content',
	maxWidth: '100%',
}

const ownerLinkCss = {
	color: colors.textMuted,
	fontWeight: 550,
	textDecoration: 'none',
	'&:hover': {
		color: colors.primaryText,
	},
}

const ownerPrivateNameCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.25rem',
	minWidth: 0,
}

const ownerPrivateLockCss = {
	display: 'inline-flex',
	alignItems: 'center',
	color: colors.textMuted,
	cursor: 'help',
	flexShrink: 0,
}

const badgeCss = {
	...communityBadgePillCss,
}

const detailSubCss = {
	margin: '1.4rem 0 0',
	color: colors.textMuted,
	fontSize: '1.05rem',
	maxWidth: '58ch',
}

const filesLinkRowCss = {
	margin: '0.7rem 0 0',
}

const filesLinkCss = {
	color: colors.primaryText,
	fontWeight: 550,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}

const detailTagListCss = {
	...communityTagListCss,
	marginTop: '1rem',
}

const detailCategoryLinkCss = {
	color: colors.primaryText,
	fontWeight: 550,
	textDecoration: 'underline',
	textUnderlineOffset: '0.18em',
	'&:hover': {
		color: colors.text,
	},
}

const metaCss = {
	margin: '1.6rem 0 0',
	padding: '1rem 0',
	borderBlock: `1px solid ${colors.border}`,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.5rem 2rem',
	fontSize: '0.92rem',
	'& > div': {
		display: 'flex',
		gap: '0.45rem',
		alignItems: 'baseline',
	},
	'& dt': {
		margin: 0,
		color: colors.textMuted,
	},
	'& dd': {
		margin: 0,
		color: colors.text,
		fontWeight: 550,
	},
	'& dd code': {
		font: '500 0.88rem/1.2 ui-monospace, "SF Mono", Menlo, monospace',
	},
}
