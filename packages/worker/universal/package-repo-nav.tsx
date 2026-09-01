/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { css } from 'remix/ui'
import { getPackageSettingsHref } from '#universal/package-files.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export type PackageRepoNavActive = 'code' | 'settings'

export function renderPackageVisibilityBadge(isPrivate: boolean) {
	return (
		<span
			data-testid="package-visibility-badge"
			data-visibility={isPrivate ? 'private' : 'public'}
			mix={css(isPrivate ? privateBadgeCss : publicBadgeCss)}
		>
			{isPrivate ? 'Private' : 'Public'}
		</span>
	)
}

export function renderPackageRepoNav(input: {
	username: string
	kodyId: string
	viewerIsOwner: boolean
	active: PackageRepoNavActive
}) {
	const codeHref = routes.communityPackage.href({
		username: input.username,
		kodyId: input.kodyId,
	})
	const settingsHref = getPackageSettingsHref({
		username: input.username,
		kodyId: input.kodyId,
	})
	return (
		<nav aria-label="Package" data-testid="package-repo-nav" mix={css(navCss)}>
			<a
				href={codeHref}
				aria-current={input.active === 'code' ? 'page' : undefined}
				data-testid="package-repo-nav-code"
				mix={css(tabCss)}
			>
				Code
			</a>
			{input.viewerIsOwner ? (
				<a
					href={settingsHref}
					aria-current={input.active === 'settings' ? 'page' : undefined}
					data-testid="package-repo-nav-settings"
					mix={css(tabCss)}
				>
					Settings
				</a>
			) : null}
		</nav>
	)
}

export function renderPackageRepoChrome(input: {
	username: string
	kodyId: string
	isPrivate: boolean
	viewerIsOwner: boolean
	active: PackageRepoNavActive
	description?: string
	ownerProfilePublic?: boolean
	animate?: boolean
}) {
	const backHref = input.viewerIsOwner
		? routes.accountPackages.href()
		: routes.community.href()
	const backLabel = input.viewerIsOwner ? 'Packages' : 'Public packages'
	const profileHref =
		input.ownerProfilePublic === false
			? null
			: routes.profile.href({ username: input.username })
	const rise = (step: string) =>
		input.animate
			? ({
					'data-rise': true,
					style: { '--rise': step },
				} as const)
			: {}

	return (
		<div data-testid="package-repo-chrome">
			<a
				{...rise('0')}
				href={backHref}
				data-testid="package-repo-back"
				mix={css(backLinkCss)}
			>
				← {backLabel}
			</a>
			<header {...rise('1')} mix={css(headCss)}>
				<h1 mix={css(titleCss)}>
					{profileHref ? (
						<a href={profileHref} mix={css(ownerLinkCss)}>
							@{input.username}
						</a>
					) : (
						<span data-testid="community-detail-owner-private">
							@{input.username}
						</span>
					)}
					<span mix={css(slashCss)}>/</span>
					<span>{input.kodyId}</span>
					{renderPackageVisibilityBadge(input.isPrivate)}
				</h1>
			</header>
			{input.description ? (
				<p {...rise('2')} mix={css(descriptionCss)}>
					{input.description}
				</p>
			) : null}
			<div {...rise('3')}>
				{renderPackageRepoNav({
					username: input.username,
					kodyId: input.kodyId,
					viewerIsOwner: input.viewerIsOwner,
					active: input.active,
				})}
			</div>
		</div>
	)
}

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

const headCss = {
	marginTop: '1.8rem',
}

const titleCss = {
	margin: 0,
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.45rem',
	fontSize: 'clamp(1.5rem, 3.6vw, 2rem)',
	fontWeight: 760,
	letterSpacing: '-0.024em',
	lineHeight: 1.15,
	overflowWrap: 'anywhere' as const,
}

const slashCss = {
	color: colors.textMuted,
	fontWeight: 500,
}

const ownerLinkCss = {
	color: colors.text,
	fontWeight: 550,
	textDecoration: 'none',
	'&:hover': {
		color: colors.primaryText,
	},
}

const descriptionCss = {
	margin: '1rem 0 0',
	color: colors.textMuted,
	fontSize: '1.05rem',
	maxWidth: '58ch',
}

const badgeCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.medium,
	lineHeight: 1.2,
}

const privateBadgeCss = {
	...badgeCss,
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	color: colors.textMuted,
}

const publicBadgeCss = {
	...badgeCss,
	backgroundColor: colors.primarySoft,
	border: 'none',
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
}

const navCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	marginTop: '1.1rem',
	borderBottom: `1px solid ${colors.border}`,
}

const tabCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: '0.55rem 0.15rem',
	marginBottom: '-1px',
	borderBottom: '2px solid transparent',
	color: colors.textMuted,
	fontSize: '0.95rem',
	fontWeight: 550,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
	'&[aria-current="page"]': {
		color: colors.text,
		borderBottomColor: colors.primary,
	},
}
