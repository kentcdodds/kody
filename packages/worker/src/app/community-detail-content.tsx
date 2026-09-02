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
import {
	communityTagListCss,
	communityTagPillCss,
	renderCommunityViewerInstallBadge,
} from '#app/community-listings-content.tsx'
import {
	fallbackDefaultBranchName,
	getPackageTreeHref,
} from '#universal/package-files.ts'
import { renderPackageRepoChrome } from '#universal/package-repo-nav.tsx'
import { routes } from '#universal/routes.ts'
import { colors } from '#universal/styles/tokens.ts'
import { buildPackagePublishApprovalPath } from '#worker/package-registry/package-publish-lock.ts'

/**
 * Server-rendered package head (the `community-detail` frame): GitHub-style
 * `@owner / name` + visibility + Code/Settings tabs, then the public catalog
 * extras (icon, install badges, tags, facts) when a listing exists.
 */

export type CommunityDetailContentProps = {
	listing: PublicCommunityListing | null
	username: string
	kodyId: string
	description: string
	isPrivate: boolean
	ownerProfilePublic: boolean
	loggedIn: boolean
	viewerIsOwner: boolean
	returnTo: string
	treeRef?: string
	publishCompareHref?: string | null
}

export function CommunityDetailContent(
	handle: Handle<CommunityDetailContentProps>,
) {
	const {
		listing,
		username,
		kodyId,
		description,
		isPrivate,
		ownerProfilePublic,
		loggedIn,
		viewerIsOwner,
		returnTo,
		treeRef,
		publishCompareHref,
	} = handle.props

	const filesHref = getPackageTreeHref({
		username,
		kodyId,
		listingId: listing?.id,
		ref: listing?.defaultBranch ?? treeRef ?? fallbackDefaultBranchName,
	})

	return () => (
		<div data-testid="community-detail-frame">
			{renderPackageRepoChrome({
				username,
				kodyId,
				isPrivate,
				viewerIsOwner,
				active: 'code',
				description,
				ownerProfilePublic,
				animate: true,
			})}

			{listing ? (
				<header data-rise style={{ '--rise': '2' }} mix={css(listingHeadCss)}>
					<CommunityListingIcon listing={listing} size="detail" />
					<div mix={css(listingBadgeGroupCss)}>
						{listing.sourceAhead ? (
							publishCompareHref ? (
								<a
									href={publishCompareHref}
									data-testid="community-detail-source-ahead-badge"
									title="Review the unpublished HEAD changes, then publish them."
									mix={css(badgeLinkCss)}
								>
									HEAD ahead of published
								</a>
							) : (
								<span
									data-testid="community-detail-source-ahead-badge"
									title="Default-branch HEAD is newer than the last package publish. Source at HEAD is already public; runtime still uses the published commit."
									mix={css(badgeCss)}
								>
									HEAD ahead of published
								</span>
							)
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
					</div>
				</header>
			) : null}

			<p data-rise style={{ '--rise': '3' }} mix={css(filesLinkRowCss)}>
				<a
					href={filesHref}
					data-testid="community-browse-files"
					mix={css(filesLinkCss)}
				>
					Browse files
				</a>
			</p>

			{listing ? (
				<>
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

					<dl data-rise style={{ '--rise': '4' }} mix={css(metaCss)}>
						{listing.version ? (
							<div>
								<dt>Version</dt>
								<dd data-testid="community-detail-version">
									{listing.version}
								</dd>
							</div>
						) : null}
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
								{formatCommunityStars(
									listing.averageStars,
									listing.ratingCount,
								)}
							</dd>
						</div>
						<div>
							<dt>Forks</dt>
							<dd data-testid="community-detail-forks">{listing.forkCount}</dd>
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
				</>
			) : null}
		</div>
	)
}

export async function renderCommunityDetailContentHtml(
	props: CommunityDetailContentProps,
) {
	return renderToString(<CommunityDetailContent {...props} />)
}

const listingHeadCss = {
	marginTop: '1.4rem',
	display: 'flex',
	alignItems: 'flex-start',
	gap: '1.1rem',
}

const listingBadgeGroupCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.35rem',
	paddingTop: '0.35rem',
}

const badgeCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: '0.15rem 0.55rem',
	borderRadius: '999px',
	fontSize: '0.78rem',
	fontWeight: 600,
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	color: colors.textMuted,
}

const badgeLinkCss = {
	...badgeCss,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
		borderColor: colors.textMuted,
	},
}

export function buildSourceAheadPublishHref(input: {
	packageId: string | null | undefined
	headCommit: string | null | undefined
}) {
	if (!input.packageId) return null
	if (input.headCommit) {
		return buildPackagePublishApprovalPath({
			packageId: input.packageId,
			commit: input.headCommit,
		})
	}
	return routes.accountPackageApprovePublish.href({
		packageId: input.packageId,
	})
}

const filesLinkRowCss = {
	margin: '0.9rem 0 0',
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
