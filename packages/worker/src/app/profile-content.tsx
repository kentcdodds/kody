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
	type ProfilePackageFilters,
	type ProfilePackageHiddenFilter,
	type ProfilePackageListingFilter,
	type ProfilePackageVisibilityFilter,
	type PublicCommunityActivityItem,
	type PublicCommunityProfile,
	type PublicProfilePackageItem,
} from '#universal/community-public-types.ts'
import { getCommunityListingHref } from '#universal/community-links.ts'
import {
	buildProfileHref,
	profilePackageFiltersAreActive,
} from '#universal/profile-search.ts'
import { routes } from '#universal/routes.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'
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
} from '#universal/styles/style-primitives.ts'

export type ProfileContentProps = {
	profile: PublicCommunityProfile
	packages: Array<PublicProfilePackageItem>
	activity: Array<PublicCommunityActivityItem>
	query: string | null
	visibility?: ProfilePackageVisibilityFilter
	listing?: ProfilePackageListingFilter
	hidden?: ProfilePackageHiddenFilter
	isSelf: boolean
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

type ProfileFilterChoice<Filter extends string> = {
	value: Filter
	label: string
	title?: string
}

function renderProfileFilterNav<Filter extends string>(input: {
	label: string
	ariaLabel: string
	testId: string
	selected: Filter
	choices: Array<ProfileFilterChoice<Filter>>
	hrefFor: (value: Filter) => string
}) {
	return (
		<nav
			aria-label={input.ariaLabel}
			data-testid={input.testId}
			mix={css(filterNavCss)}
		>
			<span aria-hidden="true" mix={css(filterNavLabelCss)}>
				{input.label}
			</span>
			{input.choices.map((choice) => (
				<a
					key={choice.value}
					href={input.hrefFor(choice.value)}
					aria-current={input.selected === choice.value ? 'page' : undefined}
					title={choice.title}
					mix={css(filterLinkCss)}
				>
					{choice.label}
				</a>
			))}
		</nav>
	)
}

/**
 * GET filter pills above the package list, in the same grammar as the
 * community category chips. Every link carries the other active filters and
 * the search query so narrowing one axis never resets another. Guests only
 * get the listing axis; visibility, hidden, and "needs republish" describe
 * owner-only inventory the server ignores for them anyway.
 */
function renderProfilePackageFilters(input: {
	username: string
	filters: ProfilePackageFilters
	isSelf: boolean
}) {
	const { username, filters, isSelf } = input
	const listingChoices: Array<
		ProfileFilterChoice<ProfilePackageListingFilter>
	> = [
		{ value: 'all', label: 'All' },
		{ value: 'published', label: 'Published' },
		{ value: 'unpublished', label: 'Not published' },
	]
	if (isSelf) {
		listingChoices.push({
			value: 'ahead',
			label: 'Needs republish',
			title: 'Published packages edited since their last publish',
		})
	}
	return (
		<div data-testid="profile-package-filters" mix={css(filterToolbarCss)}>
			{isSelf
				? renderProfileFilterNav<ProfilePackageVisibilityFilter>({
						label: 'Visibility',
						ariaLabel: 'Filter packages by visibility',
						testId: 'profile-package-filter-visibility',
						selected: filters.visibility,
						choices: [
							{ value: 'all', label: 'All' },
							{ value: 'public', label: 'Public' },
							{ value: 'private', label: 'Private' },
						],
						hrefFor: (visibility) =>
							buildProfileHref({ username, ...filters, visibility }),
					})
				: null}
			{renderProfileFilterNav<ProfilePackageListingFilter>({
				label: 'Listing',
				ariaLabel: 'Filter packages by community listing',
				testId: 'profile-package-filter-listing',
				selected: filters.listing,
				choices: listingChoices,
				hrefFor: (listing) =>
					buildProfileHref({ username, ...filters, listing }),
			})}
			{isSelf
				? renderProfileFilterNav<ProfilePackageHiddenFilter>({
						label: 'Hidden',
						ariaLabel: 'Filter packages by hidden state',
						testId: 'profile-package-filter-hidden',
						selected: filters.hidden,
						choices: [
							{ value: 'all', label: 'All' },
							{ value: 'yes', label: 'Hidden' },
							{ value: 'no', label: 'Visible' },
						],
						hrefFor: (hidden) =>
							buildProfileHref({ username, ...filters, hidden }),
					})
				: null}
		</div>
	)
}

function renderProfilePackagesEmptyCopy(input: {
	query: string | null
	filtersActive: boolean
	isSelf: boolean
}) {
	if (input.query) return 'No packages matched your search.'
	if (input.filtersActive) return 'No packages matched these filters.'
	return input.isSelf
		? 'You have no packages yet.'
		: 'No public packages to take yet.'
}

export function ProfileContent(handle: Handle<ProfileContentProps>) {
	return () => {
		const { profile, packages, activity, query, isSelf } = handle.props
		const filters: ProfilePackageFilters = {
			query: query ?? '',
			visibility: handle.props.visibility ?? 'all',
			listing: handle.props.listing ?? 'all',
			hidden: handle.props.hidden ?? 'all',
		}
		const filtersActive = profilePackageFiltersAreActive(filters)
		const showFilters =
			isSelf || packages.length > 0 || Boolean(query) || filtersActive

		return (
			<div data-testid="profile-frame">
				<section mix={css(sectionCss)} data-testid="profile-packages">
					{showFilters
						? renderProfilePackageFilters({
								username: profile.username,
								filters,
								isSelf,
							})
						: null}
					{packages.length === 0 ? (
						<p mix={css(emptyCss)} data-testid="profile-packages-empty">
							{renderProfilePackagesEmptyCopy({ query, filtersActive, isSelf })}
						</p>
					) : (
						<ul mix={css(packageListCss)}>
							{packages.map((pkg) => {
								const packageHref = routes.communityPackage.href({
									username: profile.username,
									kodyId: pkg.communityListingKodyId ?? pkg.kodyId,
								})
								const listingHref = pkg.communityListingId
									? getCommunityListingHref({
											listingId: pkg.communityListingId,
											ownerUsername: profile.username,
											kodyId: pkg.communityListingKodyId,
										})
									: null
								return (
									<li key={pkg.kodyId} mix={css(cardCss)}>
										<div mix={css(packageHeadingCss)}>
											<div mix={css(packageTitleGroupCss)}>
												{listingHref ? (
													<a
														href={listingHref}
														title="fork"
														aria-label="fork"
														mix={css(forkButtonCss)}
													>
														{renderForkIcon()}
													</a>
												) : null}
												<h3 mix={css(packageNameCss)}>
													<a href={packageHref} mix={css(packageNameLinkCss)}>
														{renderCommunityListingName(pkg.name)}
													</a>
												</h3>
											</div>
											{pkg.hidden ? (
												<span mix={css(unpublishedBadgeCss)}>Hidden</span>
											) : null}
											{pkg.isPrivate ? (
												<span mix={css(unpublishedBadgeCss)}>Private</span>
											) : null}
											{pkg.communityListingId ? (
												<span mix={css(communityBadgeCss)}>Community</span>
											) : (
												<span mix={css(unpublishedBadgeCss)}>
													Not published
												</span>
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

				<section mix={css(activitySectionCss)} data-testid="profile-activity">
					<h2 mix={css(sectionTitleCss)}>Recent activity</h2>
					<p mix={css(mutedCss)} data-testid="profile-activity-hint">
						Community publishes and forks. Editing a package without
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
												href={getCommunityListingHref({
													listingId: item.listingId,
													listingName: item.listingName,
													kodyId: item.listingKodyId,
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
}

export async function renderProfileContentHtml(props: ProfileContentProps) {
	return renderToString(<ProfileContent {...props} />)
}

const activityActorCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.sm,
}

const sectionCss = {
	display: 'grid',
	gap: spacing.md,
}

const filterToolbarCss = {
	display: 'grid',
	gap: spacing.sm,
}

/* Same bordered-pill grammar as the community category chips. */
const filterNavCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: '0.4rem',
	'& a': {
		display: 'inline-flex',
		alignItems: 'center',
		minHeight: '44px',
		backgroundColor: colors.surface,
		border: `1.5px solid ${colors.border}`,
		borderRadius: '999px',
		padding: '0.35rem 0.85rem',
	},
}

const filterNavLabelCss = {
	color: colors.textMuted,
	fontSize: '0.8rem',
	fontWeight: 600,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.04em',
	minWidth: '5.5rem',
}

const filterLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	minHeight: '44px',
	padding: '0.3rem 0.95rem',
	borderRadius: '999px',
	color: colors.textMuted,
	fontSize: '0.88rem',
	fontWeight: 650,
	lineHeight: 1.2,
	textDecoration: 'none',
	transition: `background-color 140ms ${transitions.easeOut}, color 140ms ${transitions.easeOut}, border-color 140ms ${transitions.easeOut}`,
	'&:hover': {
		color: colors.text,
	},
	'&[aria-current="page"]': {
		backgroundColor: colors.primarySoft,
		borderColor: colors.primarySoft,
		color: colors.primaryText,
	},
}

const activitySectionCss = {
	...sectionCss,
	marginTop: spacing.xl,
}

const emptyCss = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '42ch',
	textWrap: 'pretty' as const,
}

const sectionTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
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
