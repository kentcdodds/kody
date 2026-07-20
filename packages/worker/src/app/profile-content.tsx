/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import {
	communityActivityVerb,
	formatCommunityActivityDate,
} from '#app/community-activity-display.ts'
import { formatCommunityPublishedDate } from '#app/community-display.ts'
import {
	type PublicCommunityActivityItem,
	type PublicCommunityProfile,
	type PublicProfilePackageItem,
} from '#app/community-public-types.ts'
import { routes } from '#app/routes.ts'
import { UserAvatar } from '#app/user-avatar.tsx'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
} from '#client/styles/style-primitives.ts'

export type ProfileContentProps = {
	profile: PublicCommunityProfile
	packages: Array<PublicProfilePackageItem>
	activity: Array<PublicCommunityActivityItem>
	query: string | null
	isSelf: boolean
}

export function ProfileContent(handle: Handle<ProfileContentProps>) {
	const { profile, packages, activity, query, isSelf } = handle.props

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
						<p mix={css(pageDescriptionCss)} data-testid="profile-username">
							@{profile.username}
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
						{packages.map((pkg) => (
							<li key={pkg.kodyId} mix={css(cardCss)}>
								<div mix={css(packageHeadingCss)}>
									<h3 mix={css(packageNameCss)}>{pkg.name}</h3>
									{pkg.communityListingId ? (
										<span mix={css(communityBadgeCss)}>Community</span>
									) : (
										<span mix={css(unpublishedBadgeCss)}>Not published</span>
									)}
								</div>
								<p mix={css(mutedCss)}>{pkg.kodyId}</p>
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
									Updated {formatCommunityPublishedDate(pkg.updatedAt)}
								</p>
								{pkg.communityListingId ? (
									<p mix={css(packageActionsCss)}>
										<a
											href={routes.communityDetail.href({
												listingId: pkg.communityListingId,
											})}
											mix={css(mutedLinkCss)}
										>
											View listing
										</a>
										<a
											href={routes.communityDetail.href({
												listingId: pkg.communityListingId,
											})}
											mix={css(mutedLinkCss)}
										>
											Fork
										</a>
									</p>
								) : null}
							</li>
						))}
					</ul>
				)}
			</section>

			<section mix={css(sectionCss)} data-testid="profile-activity">
				<h2 mix={css(sectionTitleCss)}>Recent activity</h2>
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

const packageNameCss = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
	overflowWrap: 'anywhere' as const,
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

const packageActionsCss = {
	display: 'flex',
	gap: spacing.md,
	margin: 0,
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
