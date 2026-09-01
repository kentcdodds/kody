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
	viewerIsOwner: boolean
	returnTo: string
}

export function CommunityDetailContent(
	handle: Handle<CommunityDetailContentProps>,
) {
	const { listing, ownerProfilePublic, loggedIn, viewerIsOwner, returnTo } =
		handle.props

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
						ref: listing.defaultBranch,
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
