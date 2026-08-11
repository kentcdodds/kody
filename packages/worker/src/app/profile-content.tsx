/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import {
	communityActivityVerb,
	formatCommunityActivityDate,
} from '#universal/community-activity-display.ts'
import { formatCommunityPublishedDate } from '#universal/community-display.ts'
import { renderCommunityListingName } from '#universal/community-listing-name.tsx'
import {
	type PublicCommunityActivityItem,
	type PublicCommunityProfile,
	type PublicProfilePackageItem,
} from '#universal/community-public-types.ts'
import { routes } from '#universal/routes.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'
import { renderProfileFollowControl } from '#app/profile-follow-control.tsx'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	hoverMq,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
} from '#universal/styles/style-primitives.ts'

export type ProfileContentProps = {
	profile: PublicCommunityProfile
	packages: Array<PublicProfilePackageItem>
	activity: Array<PublicCommunityActivityItem>
	query: string | null
	isSelf: boolean
	loggedIn: boolean
	isFollowing: boolean
	returnTo: string
	followError: string | null
}

function renderForkIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			aria-hidden="true"
			focusable={false}
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx="12" cy="18" r="3" />
			<circle cx="6" cy="6" r="3" />
			<circle cx="18" cy="6" r="3" />
			<path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
			<path d="M12 12v3" />
		</svg>
	)
}

/**
 * Package cards carry two unrelated timestamps: the community listing's
 * published_at and the owner's local saved-package edit time. Only the
 * published date lines up with the activity feed, so unpublished edits are
 * labelled as edits and shown to the owner alone as a republish reminder.
 */
function renderProfilePackageDates(
	pkg: PublicProfilePackageItem,
	options: { isSelf: boolean },
) {
	if (!pkg.communityPublishedAt) {
		return `Edited ${formatCommunityPublishedDate(pkg.updatedAt)}`
	}
	const published = `Published ${formatCommunityPublishedDate(pkg.communityPublishedAt)}`
	const hasUnpublishedEdits = pkg.updatedAt > pkg.communityPublishedAt
	if (!options.isSelf || !hasUnpublishedEdits) return published
	return `${published} · edited ${formatCommunityPublishedDate(pkg.updatedAt)}, not republished`
}

export function ProfileContent(handle: Handle<ProfileContentProps>) {
	const {
		profile,
		packages,
		activity,
		query,
		isSelf,
		loggedIn,
		isFollowing,
		returnTo,
		followError,
	} = handle.props

	return () => (
		<div data-testid="profile-frame">
			<header mix={css(pageHeaderCss)}>
				<div mix={css(profileHeadingCss)}>
					<UserAvatar
						displayName={profile.displayName}
						avatarUrl={profile.avatarUrl}
						size={80}
						testId="profile-avatar"
					/>
					<div>
						<h1 mix={css(pageTitleCss)} data-testid="profile-display-name">
							{profile.displayName}
						</h1>
						<p mix={css(profileUsernameLineCss)} data-testid="profile-username">
							<span>@{profile.username}</span>
							{!isSelf
								? renderProfileFollowControl({
										username: profile.username,
										loggedIn,
										isFollowing,
										returnTo,
										followError,
										testId: 'profile-follow',
										errorTestId: 'profile-follow-error',
									})
								: null}
						</p>
					</div>
				</div>
				{profile.bio ? (
					<p mix={css(descriptionCss)} data-testid="profile-bio">
						{profile.bio}
					</p>
				) : null}
				{isSelf && profile.visibility === 'private' ? (
					<p
						mix={css(privateNoticeCss)}
						data-testid="profile-private-notice"
						role="status"
					>
						Your profile is private
					</p>
				) : null}
				<dl mix={css(statsCss)}>
					<div>
						<dt>Joined</dt>
						<dd data-testid="profile-joined">
							{formatCommunityPublishedDate(profile.joinedAt)}
						</dd>
					</div>
					<div>
						<dt>Followers</dt>
						<dd data-testid="profile-followers">{profile.followerCount}</dd>
					</div>
					<div>
						<dt>Following</dt>
						<dd data-testid="profile-following">{profile.followingCount}</dd>
					</div>
				</dl>
			</header>

			<section mix={css(sectionCss)} data-testid="profile-packages">
				<h2 mix={css(sectionTitleCss)}>Packages</h2>
				{packages.length === 0 ? (
					<p mix={css(descriptionCss)}>
						{query
							? 'No packages matched your search.'
							: 'No public packages yet.'}
					</p>
				) : (
					<ul mix={css(packageListCss)}>
						{packages.map((pkg) => {
							const listingHref = pkg.communityListingId
								? routes.communityDetail.href({
										listingId: pkg.communityListingId,
									})
								: null
							return (
								<li key={pkg.kodyId} mix={css(cardCss)}>
									<div mix={css(packageHeadingCss)}>
										<div mix={css(packageTitleGroupCss)}>
											{listingHref ? (
												<a
													href={`${listingHref}#fork-title`}
													title="fork"
													aria-label="fork"
													mix={css(forkButtonCss)}
												>
													{renderForkIcon()}
												</a>
											) : null}
											<h3 mix={css(packageNameCss)}>
												{listingHref ? (
													<a href={listingHref} mix={css(packageNameLinkCss)}>
														{renderCommunityListingName(pkg.name)}
													</a>
												) : (
													renderCommunityListingName(pkg.name)
												)}
											</h3>
										</div>
										{pkg.communityListingId ? (
											<span mix={css(communityBadgeCss)}>Community</span>
										) : (
											<span mix={css(unpublishedBadgeCss)}>Not published</span>
										)}
									</div>
									{pkg.description ? (
										<p mix={css(descriptionCss)}>{pkg.description}</p>
									) : null}
									{pkg.tags.length > 0 ? (
										<ul mix={css(tagListCss)}>
											{pkg.tags.map((tag) => (
												<li key={tag} mix={css(tagPillCss)}>
													{tag}
												</li>
											))}
										</ul>
									) : null}
									<p mix={css(mutedCss)}>
										{renderProfilePackageDates(pkg, { isSelf })}
									</p>
								</li>
							)
						})}
					</ul>
				)}
			</section>

			<section mix={css(sectionCss)} data-testid="profile-activity">
				<h2 mix={css(sectionTitleCss)}>Recent activity</h2>
				<p mix={css(mutedCss)} data-testid="profile-activity-hint">
					Community publishes, forks, and stars. Editing a package without
					republishing it does not appear here.
				</p>
				{activity.length === 0 ? (
					<p mix={css(descriptionCss)}>No public activity yet.</p>
				) : (
					<ul mix={css(activityListCss)}>
						{activity.map((item) => (
							<li
								key={`${item.type}:${item.listingId}:${item.createdAt}`}
								mix={css(activityItemCss)}
							>
								<span mix={css(activityActorCss)}>
									<UserAvatar
										displayName={item.actorDisplayName}
										avatarUrl={item.actorAvatarUrl}
										size={32}
									/>
									<span>
										{communityActivityVerb(item.type)}{' '}
										<a
											href={routes.communityDetail.href({
												listingId: item.listingId,
											})}
											mix={css(mutedLinkCss)}
										>
											{item.listingName}
										</a>
									</span>
								</span>
								<time
									dateTime={item.createdAt}
									mix={css(mutedCss)}
									title={item.createdAt}
								>
									{formatCommunityActivityDate(item.createdAt)}
								</time>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	)
}

export async function renderProfileContentHtml(props: ProfileContentProps) {
	return renderToString(<ProfileContent {...props} />)
}

const profileHeadingCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
}

const profileUsernameLineCss = {
	...pageDescriptionCss,
	display: 'inline-flex',
	alignItems: 'center',
	flexWrap: 'nowrap' as const,
	gap: '0.45rem',
}

const activityActorCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.sm,
}

const sectionCss = {
	display: 'grid',
	gap: spacing.md,
	marginTop: spacing.xl,
}

const sectionTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const statsCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
	gap: spacing.md,
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

const privateNoticeCss = {
	margin: 0,
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.md,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	width: 'fit-content',
}

const packageListCss = {
	display: 'grid',
	gap: spacing.md,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}

const packageHeadingCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
}

const packageTitleGroupCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	minWidth: 0,
	flex: '1 1 auto',
}

const packageNameCss = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
	overflowWrap: 'anywhere' as const,
	minWidth: 0,
}

const packageNameLinkCss = {
	color: 'inherit',
	textDecoration: 'none',
	'&:hover': {
		color: colors.primaryText,
	},
}

const forkButtonCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flex: 'none',
	width: '1.75rem',
	height: '1.75rem',
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: 'transparent',
	color: colors.textMuted,
	textDecoration: 'none',
	transition: `color ${transitions.fast}, border-color ${transitions.fast}, background-color ${transitions.fast}`,
	[hoverMq]: {
		'&:hover': {
			color: colors.primaryText,
			borderColor: colors.primaryText,
			backgroundColor: colors.primarySoftest,
		},
	},
}

const communityBadgeCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	backgroundColor: colors.primarySoft,
	color: colors.primaryText,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
}

const unpublishedBadgeCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.medium,
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

const activityListCss = {
	display: 'grid',
	gap: spacing.sm,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}

const activityItemCss = {
	display: 'flex',
	justifyContent: 'space-between',
	gap: spacing.md,
	flexWrap: 'wrap' as const,
	fontSize: typography.fontSize.sm,
	color: colors.text,
}

const mutedCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}
