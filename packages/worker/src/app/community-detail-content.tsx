/** @jsxImportSource remix/component */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/component'
import { renderToString } from 'remix/component/server'
import { buildPackageAppPath } from '@kody-internal/shared/public-urls.ts'
import { type PublicCommunityListing } from '#app/community-public.ts'
import { communityPackageCategoryCopy } from '#universal/community-categories.ts'
import { buildCommunityIndexHref } from '#universal/community-search.ts'
import {
	formatCommunityAdaptationEffort,
	formatCommunityPublishedDate,
	formatCommunityStars,
	shortCommunityCommit,
} from '#universal/community-display.ts'
import { renderIcon } from '#universal/icon.tsx'
import {
	packageActionPrimaryCss,
	packageActionSecondaryCss,
	renderPackageTitleActions,
} from '#universal/package-title-actions.tsx'
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
import { buildUpdatePublicListingHref } from '#universal/update-public-listing.ts'

/**
 * Server-rendered package head (the `community-detail` frame): GitHub-style
 * icon + `@owner / name` + visibility + Repo/Files/Settings tabs, then the
 * public catalog extras (install badges, tags, facts) when a listing exists.
 */

/** GitHub-rendered agent docs for plain repos (not a /docs catalog guide). */
const plainReposPromoteDocsHref =
	'https://github.com/kentcdodds/kody/blob/main/docs/use/repos.md#promote-flow'

export type CommunityDetailContentProps = {
	listing: PublicCommunityListing | null
	username: string
	kodyId: string
	description: string
	isPrivate: boolean
	ownerProfilePublic: boolean
	loggedIn: boolean
	viewerIsOwner: boolean
	viewerCanManage: boolean
	returnTo: string
	treeRef?: string
	publishCompareHref?: string | null
	hasApp?: boolean
	/** Defaults to true. Plain repos pass false for the Repo mark. */
	hasPackage?: boolean
	/**
	 * Plain repos only (owners/members): root package.json at the indexed
	 * commit. Surfaces promote-to-package guidance — no website promote API.
	 */
	packageShaped?: boolean
	iconUrl?: string | null
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
		viewerCanManage,
		returnTo,
		treeRef,
		publishCompareHref,
		hasApp,
		hasPackage,
		packageShaped,
		iconUrl,
	} = handle.props
	const packageAppHref = resolvePackageAppHref({
		hasApp: hasApp === true,
		username,
		kodyId,
		viewerIsOwner,
	})
	const markUrl = listing?.iconUrl ?? iconUrl ?? null
	const isPackage = hasPackage !== false
	const showPlainRepoOwnerHints = !isPackage && viewerIsOwner

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
				isListed: listing != null,
				hasPackage: isPackage,
				viewerIsOwner,
				viewerCanManage,
				active: 'repo',
				filesHref,
				description,
				ownerProfilePublic,
				iconUrl: markUrl,
				iconName: listing?.name ?? kodyId,
				animate: true,
				actions: renderRepoActions({
					listing,
					viewerIsOwner,
					viewerCanManage,
					loggedIn,
					returnTo,
					publishCompareHref,
					packageAppHref,
				}),
			})}

			{listing
				? renderListingHead({
						listing,
						loggedIn,
						returnTo,
						viewerIsOwner,
						viewerCanManage,
						publishCompareHref,
					})
				: null}

			{showPlainRepoOwnerHints
				? renderPlainRepoOwnerHints({
						kodyId,
						packageShaped: packageShaped === true,
					})
				: null}

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

function renderRepoActions(input: {
	listing: PublicCommunityListing | null
	viewerIsOwner: boolean
	viewerCanManage: boolean
	loggedIn: boolean
	returnTo: string
	publishCompareHref?: string | null
	packageAppHref: string | null
}) {
	const { listing } = input
	const visitorActions = listing
		? renderPackageTitleActions({
				viewerIsOwner: input.viewerIsOwner,
				loggedIn: input.loggedIn,
				returnTo: input.returnTo,
				listingId: listing.id,
				trusted: listing.trusted,
				viewerInstall: listing.viewerInstall ?? null,
			})
		: null
	const publishHref =
		listing?.sourceAhead && input.publishCompareHref
			? input.publishCompareHref
			: null
	const updateListingHref =
		input.viewerCanManage && listing?.listingBehind
			? buildUpdatePublicListingHref({
					username: listing.ownerUsername,
					kodyId: listing.kodyId,
				})
			: null
	if (
		!visitorActions &&
		!publishHref &&
		!updateListingHref &&
		!input.packageAppHref
	) {
		return null
	}
	return (
		<>
			{publishHref ? (
				<a
					href={publishHref}
					data-testid="community-detail-source-ahead-badge"
					title="Default-branch HEAD is newer than the last publish. Review the changes, then publish them."
					mix={css(packageActionSecondaryCss)}
				>
					{renderIcon('arrow-up-right', { size: '1.1em' })}
					Review &amp; publish
				</a>
			) : null}
			{updateListingHref ? (
				<a
					href={updateListingHref}
					data-testid="community-detail-update-public-listing"
					title="Publish and promote do not move the catalog listing. Open settings to republish the public snapshot."
					mix={css(packageActionSecondaryCss)}
				>
					{renderIcon('refresh', { size: '1.1em' })}
					Update public listing
				</a>
			) : null}
			{visitorActions}
			{input.packageAppHref ? (
				<a
					href={input.packageAppHref}
					data-testid="open-package-app"
					data-rmx-document
					mix={css(packageActionPrimaryCss)}
				>
					{renderIcon('share', { size: '1.1em' })}
					Open app
				</a>
			) : null}
		</>
	)
}

function renderListingHead(input: {
	listing: PublicCommunityListing
	loggedIn: boolean
	returnTo: string
	viewerIsOwner: boolean
	viewerCanManage: boolean
	publishCompareHref?: string | null
}) {
	const viewerBadge = renderCommunityViewerInstallBadge({
		listing: input.listing,
		variant: 'detail',
		loggedIn: input.loggedIn,
		returnTo: input.returnTo,
		viewerIsOwner: input.viewerIsOwner,
	})
	const showSourceAheadStatus =
		input.listing.sourceAhead && !input.publishCompareHref
	if (!showSourceAheadStatus && !input.listing.featured && !viewerBadge) {
		return null
	}
	return (
		<header data-rise style={{ '--rise': '2' }} mix={css(listingHeadCss)}>
			<div mix={css(listingBadgeGroupCss)}>
				{showSourceAheadStatus ? (
					<span
						data-testid="community-detail-source-ahead-badge"
						title="Default-branch HEAD is newer than the last package publish. Source at HEAD is already public; runtime still uses the published commit."
						mix={css(badgeCss)}
					>
						HEAD ahead of published
					</span>
				) : null}
				{input.listing.featured ? (
					<span
						data-testid="community-detail-featured-badge"
						title="An admin featured this package as an onboarding starter install."
						mix={css(badgeCss)}
					>
						Featured
					</span>
				) : null}
				{viewerBadge}
			</div>
		</header>
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

function resolvePackageAppHref(input: {
	hasApp: boolean
	username: string
	kodyId: string
	viewerIsOwner: boolean
}) {
	if (!input.hasApp || !input.viewerIsOwner) return null
	return buildPackageAppPath({
		username: input.username,
		kodyId: input.kodyId,
	})
}

function buildPromoteToPackagePrompt(kodyId: string) {
	return `Promote my plain Kody repo "${kodyId}" to a saved package. Open search({ entity: "capability:repoPromoteToPackage" }) if needed, then call repoPromoteToPackage({ name: "${kodyId}" }). Root package.json is already at HEAD.`
}

/**
 * Plain repos have no public smart-HTTP clone URL (that lane is packages /
 * listings only). Owners mint a short-lived Artifacts remote via MCP.
 * Promote is MCP/Open API only — no website mutate endpoint.
 */
function renderPlainRepoOwnerHints(input: {
	kodyId: string
	packageShaped: boolean
}) {
	return (
		<section
			data-rise
			style={{ '--rise': '2' }}
			data-testid="plain-repo-owner-hints"
			mix={css(plainRepoHintsCss)}
		>
			{input.packageShaped ? (
				<details mix={css(plainRepoPromoteCss)}>
					<summary mix={css(plainRepoPromoteSummaryCss)}>
						Promote to package
					</summary>
					<div mix={css(plainRepoPromptPanelCss)}>
						<p mix={css(plainRepoHintTextCss)}>
							Root <code>package.json</code> is at HEAD. Ask your agent to run{' '}
							<code>repoPromoteToPackage</code>, or follow the{' '}
							<a
								href={plainReposPromoteDocsHref}
								data-testid="plain-repo-promote-docs"
								rel="noopener noreferrer"
								target="_blank"
							>
								promote docs
							</a>
							.
						</p>
						<pre
							mix={css(plainRepoPromptCss)}
							data-testid="plain-repo-promote-prompt"
						>
							<code>{buildPromoteToPackagePrompt(input.kodyId)}</code>
						</pre>
					</div>
				</details>
			) : null}
			<p
				data-testid="plain-repo-git-remote-hint"
				mix={css(plainRepoHintTextCss)}
			>
				Clone or push with a short-lived remote from{' '}
				<code>repoGetGitRemote</code> (plain repos are not on public{' '}
				<code>.git</code> smart HTTP).
			</p>
		</section>
	)
}

export function buildSourceAheadPublishHref(input: {
	username: string
	kodyId: string
	headCommit: string | null | undefined
}) {
	if (input.headCommit) {
		return buildPackagePublishApprovalPath({
			username: input.username,
			kodyId: input.kodyId,
			commit: input.headCommit,
		})
	}
	return routes.communityPackageApprovePublish.href({
		username: input.username,
		kodyId: input.kodyId,
	})
}

const plainRepoHintsCss = {
	marginTop: '1.1rem',
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.65rem',
}

const plainRepoPromoteCss = {
	border: `1px solid ${colors.border}`,
	borderRadius: '0.55rem',
	padding: '0.55rem 0.75rem',
	backgroundColor: colors.surface,
}

const plainRepoPromoteSummaryCss = {
	cursor: 'pointer',
	fontWeight: 600,
	fontSize: '0.92rem',
	color: colors.text,
	listStyle: 'none' as const,
	'&::-webkit-details-marker': { display: 'none' },
}

const plainRepoPromptPanelCss = {
	marginTop: '0.65rem',
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.55rem',
}

const plainRepoHintTextCss = {
	margin: 0,
	fontSize: '0.88rem',
	lineHeight: 1.45,
	color: colors.textMuted,
	'& code': {
		font: '500 0.84em/1.2 ui-monospace, "SF Mono", Menlo, monospace',
		color: colors.text,
	},
	'& a': {
		color: colors.primaryText,
		fontWeight: 550,
		textDecoration: 'underline',
		textUnderlineOffset: '0.18em',
	},
}

const plainRepoPromptCss = {
	margin: 0,
	padding: '0.65rem 0.75rem',
	borderRadius: '0.45rem',
	backgroundColor: colors.background,
	border: `1px solid ${colors.border}`,
	overflowX: 'auto' as const,
	font: '500 0.8rem/1.4 ui-monospace, "SF Mono", Menlo, monospace',
	color: colors.text,
	whiteSpace: 'pre-wrap' as const,
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
