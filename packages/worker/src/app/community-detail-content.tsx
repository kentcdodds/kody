/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { type PublicCommunityListing } from '#app/community-public.ts'
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
} from '#app/community-listings-content.tsx'
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
	listing: PublicCommunityListing
	ownerProfilePublic: boolean
	loggedIn: boolean
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
		viewerFollowsOwner,
		viewerIsOwner,
		returnTo,
		followError,
	} = handle.props

	return () => (
		<div data-testid="community-detail-frame">
			<a
				data-rise
				style={{ '--rise': '0' }}
				href={routes.community.href()}
				mix={css(backLinkCss)}
			>
				← Community packages
			</a>

			<header data-rise style={{ '--rise': '1' }} mix={css(detailHeadCss)}>
				<CommunityListingIcon listing={listing} size="detail" />
				<div mix={css(headTextCss)}>
					<h1>{renderCommunityListingName(listing.name)}</h1>
					{listing.trusted || listing.featured || listing.viewerInstall ? (
						<span mix={css(detailBadgeGroupCss)}>
							{listing.trusted ? (
								<span
									data-testid="community-detail-trusted-badge"
									title="An admin reviewed this exact version and marked it trusted."
									mix={css(badgeCss)}
								>
									Trusted
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
							{listing.viewerInstall ? (
								<span
									data-testid="community-detail-viewer-install-badge"
									title={
										listing.viewerInstall.status === 'installed'
											? `Installed in your account as ${listing.viewerInstall.targetName}.`
											: `Forked in your account as ${listing.viewerInstall.targetName}; still needs adaptation.`
									}
									mix={css(badgeCss)}
								>
									{listing.viewerInstall.status === 'installed'
										? 'Installed'
										: 'Forked'}
								</span>
							) : null}
						</span>
					) : null}
					<p mix={css(ownerLineCss)}>
						<span>
							by{' '}
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
								<>
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
								</>
							)}
						</span>
						{ownerProfilePublic && !viewerIsOwner
							? renderOwnerFollowControl({
									username: listing.ownerUsername,
									loggedIn,
									viewerFollowsOwner,
									returnTo,
									followError,
								})
							: null}
					</p>
				</div>
			</header>

			<p data-rise style={{ '--rise': '2' }} mix={css(detailSubCss)}>
				{listing.description}
			</p>

			{listing.tags.length > 0 ? (
				<ul
					data-rise
					style={{ '--rise': '3' }}
					aria-label="Tags"
					mix={css(detailTagListCss)}
				>
					{listing.tags.map((tag) => (
						<li key={tag} mix={css(communityTagPillCss)}>
							{tag}
						</li>
					))}
				</ul>
			) : null}

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
					<dd data-testid="community-detail-stars">{listing.starCount}</dd>
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

function renderOwnerFollowControl(input: {
	username: string
	loggedIn: boolean
	viewerFollowsOwner: boolean
	returnTo: string
	followError: string | null
}) {
	if (!input.loggedIn) {
		const loginHref = `${routes.login.href()}?redirectTo=${encodeURIComponent(input.returnTo)}`
		return (
			<a
				href={loginHref}
				title="Follow"
				data-testid="community-detail-owner-follow"
				mix={css(ownerFollowButtonCss)}
			>
				{renderFollowGlyph(false)}
				<span mix={css(visuallyHiddenCss)}>Follow @{input.username}</span>
			</a>
		)
	}

	return (
		<span mix={css(ownerFollowControlCss)}>
			<form
				method="post"
				action={routes.profileFollowApiPost.href({ username: input.username })}
				mix={css(ownerFollowFormCss)}
			>
				<input
					type="hidden"
					name="follow"
					value={String(!input.viewerFollowsOwner)}
				/>
				<input type="hidden" name="returnTo" value={input.returnTo} />
				<button
					type="submit"
					title={input.viewerFollowsOwner ? 'Unfollow' : 'Follow'}
					data-testid="community-detail-owner-follow"
					data-following={input.viewerFollowsOwner ? 'true' : 'false'}
					mix={css(ownerFollowButtonCss)}
				>
					{renderFollowGlyph(input.viewerFollowsOwner)}
					<span mix={css(visuallyHiddenCss)}>
						{input.viewerFollowsOwner
							? `Unfollow @${input.username}`
							: `Follow @${input.username}`}
					</span>
				</button>
			</form>
			{input.followError ? (
				<span
					role="alert"
					data-testid="community-detail-owner-follow-error"
					mix={css(ownerFollowErrorCss)}
				>
					{input.followError}
				</span>
			) : null}
		</span>
	)
}

function renderFollowGlyph(following: boolean) {
	return following ? (
		<svg
			viewBox="0 0 16 16"
			width="1em"
			height="1em"
			aria-hidden="true"
			focusable={false}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx="8" cy="8" r="5.4" />
			<path d="M5.3 8.1 7.1 9.9 10.8 6.1" />
		</svg>
	) : (
		<svg
			viewBox="0 0 16 16"
			width="1em"
			height="1em"
			aria-hidden="true"
			focusable={false}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx="8" cy="8" r="5.4" />
			<path d="M8 5.2v5.6M5.2 8h5.6" />
		</svg>
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

const detailBadgeGroupCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.35rem',
}

const ownerLineCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.45rem',
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.95rem',
}

const ownerLinkCss = {
	color: colors.textMuted,
	fontWeight: 550,
	textDecoration: 'none',
	'&:hover': {
		color: colors.primaryText,
	},
}

const ownerPrivateLockCss = {
	display: 'inline-flex',
	alignItems: 'center',
	marginLeft: '0.35rem',
	color: colors.textMuted,
	verticalAlign: 'middle',
	cursor: 'help',
}

const ownerFollowControlCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.45rem',
	minWidth: 0,
}

const ownerFollowFormCss = {
	display: 'inline-flex',
	margin: 0,
}

const ownerFollowErrorCss = {
	color: colors.danger,
	fontSize: '0.85rem',
}

const ownerFollowButtonCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '1.55rem',
	height: '1.55rem',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: '999px',
	backgroundColor: 'transparent',
	color: colors.textMuted,
	textDecoration: 'none',
	cursor: 'pointer',
	'&:hover': {
		color: colors.primaryText,
		borderColor: colors.primaryText,
	},
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

const detailTagListCss = {
	...communityTagListCss,
	marginTop: '1rem',
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
