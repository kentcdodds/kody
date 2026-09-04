import { css } from 'remix/ui'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	EntityExplainer,
	resolveEntityExplainer,
} from '#client/routes/entity-explainer.tsx'
import { formatCommunityPublishedDate } from '#universal/community-display.ts'
import { type ProfileShellLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	pageDescriptionCss,
} from '#universal/styles/style-primitives.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'

const profilePagePath = (username: string) => routes.profile.href({ username })

export function renderProfileIdentity(shell: ProfileShellLoaderData) {
	const explainer = resolveEntityExplainer(profilePagePath(shell.username))
	return (
		<header mix={css(identityCss)} data-testid="profile-identity">
			<div mix={css(avatarWrapCss)}>
				<UserAvatar
					displayName={shell.displayName}
					avatarUrl={shell.avatarUrl}
					size={160}
					variant="well"
					testId="profile-avatar"
				/>
			</div>
			<div mix={css(identityCopyCss)}>
				<div mix={css(nameRowCss)}>
					<h1 mix={css(displayNameCss)} data-testid="profile-display-name">
						{shell.displayName}
					</h1>
					{shell.isSelf && shell.visibility === 'private' ? (
						<span mix={css(badgeCss)} data-testid="profile-private-badge">
							Private
						</span>
					) : null}
				</div>
				<p mix={css(usernameCss)} data-testid="profile-username">
					@{shell.username}
				</p>
				{shell.bio ? (
					<p mix={css(bioCss)} data-testid="profile-bio">
						{shell.bio}
					</p>
				) : null}
				<p mix={css(joinedCss)} data-testid="profile-joined">
					Joined {formatCommunityPublishedDate(shell.joinedAt)}
				</p>
				{shell.isSelf ? (
					<div mix={css(actionsCss)} data-testid="profile-actions">
						<a href={routes.account.href()} mix={css(getGhostButtonCss())}>
							Edit profile
						</a>
						<p mix={css(selfHintCss)}>This is how the world sees you.</p>
					</div>
				) : null}
				{!shell.loggedIn
					? renderProfileLoggedOutCtas(profilePagePath(shell.username))
					: null}
				{explainer ? (
					<EntityExplainer copy={explainer} marginTop="0.85rem" />
				) : null}
			</div>
		</header>
	)
}

export function renderProfileLoggedOutCtas(returnTo: string) {
	return (
		<div mix={css(guestCtaCss)} data-testid="profile-guest-cta">
			<p mix={css(guestCtaCopyCss)}>
				Log in or sign up to fork these packages.
			</p>
			<p mix={css(guestCtaActionsCss)}>
				<a
					href={buildAuthLink(routes.login.href(), returnTo)}
					mix={css(getGhostButtonCss())}
				>
					Log in
				</a>
				<a
					href={buildAuthLink(routes.signup.href(), returnTo)}
					mix={css(getPillButtonCss())}
				>
					Sign up
				</a>
			</p>
		</div>
	)
}

const identityCss = {
	display: 'grid',
	gap: spacing.md,
	minWidth: 0,
}

const avatarWrapCss = {
	width: '4.5rem',
	height: '4.5rem',
	lineHeight: 0,
	'& img, & span': {
		width: '4.5rem',
		height: '4.5rem',
	},
	'@media (min-width: 821px)': {
		width: '10rem',
		height: '10rem',
		'& img, & span': {
			width: '10rem',
			height: '10rem',
		},
	},
}

const identityCopyCss = {
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
}

const nameRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
}

const displayNameCss = {
	margin: 0,
	fontFamily: typography.fontFamilyDisplay,
	fontSize: 'clamp(1.65rem, 3vw, 2.15rem)',
	fontWeight: 740,
	letterSpacing: '-0.022em',
	lineHeight: 1.12,
	color: colors.text,
	overflowWrap: 'anywhere' as const,
}

const usernameCss = {
	...pageDescriptionCss,
	fontSize: typography.fontSize.lg,
	color: colors.textMuted,
}

const bioCss = {
	margin: 0,
	color: colors.text,
	maxWidth: '42ch',
	textWrap: 'pretty' as const,
	overflowWrap: 'anywhere' as const,
}

const joinedCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const badgeCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
}

const actionsCss = {
	display: 'grid',
	gap: spacing.sm,
	justifyItems: 'start',
	marginTop: spacing.xs,
}

const selfHintCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const guestCtaCss = {
	display: 'grid',
	gap: spacing.sm,
	marginTop: spacing.xs,
}

const guestCtaCopyCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	maxWidth: '36ch',
}

const guestCtaActionsCss = {
	margin: 0,
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	'& a': {
		textDecoration: 'none',
		width: 'fit-content',
	},
}
