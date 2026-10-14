import { FeaturesMenu } from '#client/features-menu.tsx'
import { type Handle, css } from 'remix/component'
import { listenToRouterNavigation } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { type IconName } from '#universal/icon.tsx'
import { UserAvatar } from '#universal/user-avatar.tsx'
import { workspaceHomeHref } from '#client/routes/account-rail.ts'
import {
	dismissOpenPopoverPanel,
	headerNavMq,
	moveSwitcherFocus,
	renderIconWell,
	renderSwitcherRow,
	switcherActionsCss,
	switcherButtonRowCss,
	switcherEyebrowCss,
	switcherLeadingCss,
	switcherPanelCss,
	switcherRowDetailCss,
	switcherRowLabelCss,
	switcherRowTextCss,
	type SwitcherRow,
} from '#client/switcher-menu.tsx'
import {
	currentSwitcherSlug,
	orderOrganizations,
	orgOverviewPath,
	orgRoleManagesBilling,
	orgSlugFromOrgOwnedPath,
	orgSlugFromPathname,
	orgUsagePath,
	organizationsWithSignupFallback,
	type OrganizationSummary,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	hoverMq,
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

export type SiteHeaderProps = {
	loggedIn: boolean
	displayName: string
	username: string
	avatarUrl: string | null
	showAdminLink: boolean
	showDemoIndicator: boolean
	loginHref: string
	currentPathname: string
	organizations?: Array<OrganizationSummary>
	lastUsedOrganization?: string | null
}

/**
 * Sticky site header from the 2026 landing redesign: brand, marketing nav
 * (Community · Docs · Pricing · Blog), and the person's avatar menu. The
 * organization switcher is the workspace rail's heading, not a header
 * control. The phone menu folds the avatar menu into its one panel. The
 * bottom hairline is a static CSS border so it paints before JS.
 */
const marketingLinks = [
	{ href: '/community', label: 'Community' },
	{ href: '/docs', label: 'Docs' },
	{ href: '/pricing', label: 'Pricing' },
	{ href: '/blog', label: 'Blog' },
] as const

/**
 * `aria-current="page"` for a nav link: exact match, or a subpath of the
 * link's section (`/blog/why` marks Blog).
 */
function ariaCurrent(currentPathname: string, href: string) {
	return currentPathname === href || currentPathname.startsWith(`${href}/`)
		? ('page' as const)
		: undefined
}

/** One id: the invoker points at the panel with `popovertarget`. */
const menuPanelId = 'site-menu'
const accountMenuPanelId = 'account-menu'

function renderLogoutRow() {
	return (
		<form
			key="logout"
			method="post"
			action={routes.logout.href()}
			mix={css({ margin: 0, display: 'grid' })}
		>
			<button
				type="submit"
				data-testid="org-switcher-logout"
				mix={css(switcherButtonRowCss)}
			>
				<span mix={css(switcherLeadingCss)}>{renderIconWell('lock')}</span>
				<span mix={css(switcherRowTextCss)}>
					<span mix={css(switcherRowLabelCss)}>Log out</span>
				</span>
			</button>
		</form>
	)
}

/**
 * Usage link for the avatar menu: org from the URL only (no last-used
 * cookie) when the viewer can open billing there, otherwise the personal org.
 * Matches the workspace rail gate (`orgRoleManagesBilling`).
 */
export function usageHrefForAccountMenu(input: {
	pathname: string
	organizations: ReadonlyArray<
		Pick<OrganizationSummary, 'slug' | 'personal' | 'role'>
	>
	username: string
}) {
	const personal =
		input.organizations.find((org) => org.personal)?.slug ??
		input.username.trim()
	const personalHref = personal ? orgUsagePath(personal) : routes.account.href()
	const usageOrgSlug = (slug: string) => {
		const org = input.organizations.find((entry) => entry.slug === slug)
		return org && orgRoleManagesBilling(org.role) ? orgUsagePath(slug) : null
	}
	const owned = orgSlugFromOrgOwnedPath(input.pathname)
	if (owned) return usageOrgSlug(owned) ?? personalHref
	const fromPath = orgSlugFromPathname(input.pathname)
	if (fromPath) return usageOrgSlug(fromPath) ?? personalHref
	return personalHref
}

function accountRows(input: {
	username: string
	currentPathname: string
	organizations: ReadonlyArray<OrganizationSummary>
}): Array<SwitcherRow> {
	const pageCurrent = (href: string) =>
		input.currentPathname === href ? ('page' as const) : undefined
	const row = (
		key: string,
		href: string,
		label: string,
		icon: IconName,
	): SwitcherRow => ({
		key,
		href,
		label,
		detail: null,
		ariaCurrent: pageCurrent(href),
		selected: false,
		leading: renderIconWell(icon),
		badge: null,
	})
	const usageHref = usageHrefForAccountMenu({
		pathname: input.currentPathname,
		organizations: input.organizations,
		username: input.username,
	})
	return [
		...(input.username
			? [
					row(
						'account-profile',
						routes.profile.href({ username: input.username }),
						'Your profile',
						'globe',
					),
				]
			: []),
		row('account-settings', routes.account.href(), 'Account settings', 'user'),
		row('account-usage', usageHref, 'Usage & credits', 'chart'),
	]
}

export type AccountMenuManageLink = {
	key: string
	href: string
	label: string
	detail: string | null
	icon: IconName
}

/**
 * The account menu's Manage links: the current workspace's Overview first,
 * then every other workspace's home. Each workspace rail lists every
 * section, so any section stays two clicks from the avatar. Unlike switcher
 * rows, which keep the current page, these always open a workspace home.
 */
export function accountMenuManageLinks(input: {
	pathname: string
	organizations: ReadonlyArray<OrganizationSummary>
	lastUsedSlug: string | null
}): Array<AccountMenuManageLink> {
	const currentSlug = currentSwitcherSlug({
		pathname: input.pathname,
		organizations: input.organizations,
		lastUsedSlug: input.lastUsedSlug,
	})
	if (!currentSlug) return []
	const current = input.organizations.find((org) => org.slug === currentSlug)
	return [
		{
			key: 'manage-overview',
			// A URL org missing from a stale session list could be a renamed
			// person's signup org, so its kind is unknown. `/-/overview` serves
			// the signup org and redirects a team to its home.
			href: current ? workspaceHomeHref(current) : orgOverviewPath(currentSlug),
			label: 'Overview',
			detail: `@${currentSlug}`,
			icon: 'home',
		},
		...orderOrganizations(input.organizations)
			.filter((org) => org.slug !== currentSlug)
			.map((org): AccountMenuManageLink => ({
				key: `manage-${org.slug}`,
				href: workspaceHomeHref(org),
				label: `@${org.slug}`,
				detail: null,
				icon: org.personal ? 'user' : 'users',
			})),
	]
}

function renderManageGroup(input: {
	links: ReadonlyArray<AccountMenuManageLink>
	currentPathname: string
	divided: boolean
}) {
	if (input.links.length === 0) return null
	return (
		<div
			role="group"
			aria-label="Manage"
			data-testid="account-menu-manage-group"
			mix={css(input.divided ? switcherActionsCss : switcherAccountListCss)}
		>
			<p mix={css(switcherEyebrowCss)}>Manage</p>
			{input.links.map((link) =>
				renderSwitcherRow({
					key: link.key,
					href: link.href,
					label: link.label,
					detail: link.detail,
					ariaCurrent: input.currentPathname === link.href ? 'page' : undefined,
					selected: false,
					leading: renderIconWell(link.icon),
					badge: null,
				}),
			)}
		</div>
	)
}

function renderAccountGroup(input: {
	username: string
	currentPathname: string
	organizations: ReadonlyArray<OrganizationSummary>
	heading: boolean
	divided: boolean
}) {
	return (
		<div
			role="group"
			aria-label="Your account"
			data-testid="org-switcher-account-group"
			mix={css(input.divided ? switcherActionsCss : switcherAccountListCss)}
		>
			{input.heading ? <p mix={css(switcherEyebrowCss)}>Your account</p> : null}
			{accountRows(input).map(renderSwitcherRow)}
			{renderLogoutRow()}
		</div>
	)
}

/**
 * The phone menu has no room for the avatar trigger, so the avatar menu's
 * groups follow the site links in the same panel.
 */
function renderPhoneAccountGroups(input: {
	username: string
	currentPathname: string
	organizations: ReadonlyArray<OrganizationSummary>
	lastUsedOrganization: string | null
}) {
	const organizations = organizationsWithSignupFallback({
		organizations: input.organizations,
		username: input.username,
	})
	const manageLinks = accountMenuManageLinks({
		pathname: input.currentPathname,
		organizations,
		lastUsedSlug: input.lastUsedOrganization,
	})
	return (
		<div
			data-menu-group
			data-testid="site-menu-account"
			mix={css(phoneAccountGroupsCss)}
		>
			{renderManageGroup({
				links: manageLinks,
				currentPathname: input.currentPathname,
				divided: false,
			})}
			{renderAccountGroup({
				username: input.username,
				currentPathname: input.currentPathname,
				organizations,
				heading: true,
				divided: manageLinks.length > 0,
			})}
		</div>
	)
}

/**
 * The person's own menu: their avatar. "Which workspace am I in" is the
 * workspace rail's switcher. Manage leads with the current workspace's
 * Overview, then every other workspace, so pages without a workspace rail
 * (account, packages) still reach every organization from here.
 */
function AccountMenu(
	handle: Handle<{
		username: string
		displayName: string
		avatarUrl: string | null
		currentPathname: string
		organizations?: Array<OrganizationSummary>
		lastUsedOrganization?: string | null
	}>,
) {
	let open = false

	function onToggle(event: { newState?: string }) {
		const next = event.newState === 'open'
		if (next === open) return
		open = next
		handle.update()
	}

	return () => {
		const name = handle.props.displayName.trim() || handle.props.username
		const organizations = organizationsWithSignupFallback({
			organizations: handle.props.organizations ?? [],
			username: handle.props.username,
		})
		const manageLinks = accountMenuManageLinks({
			pathname: handle.props.currentPathname,
			organizations,
			lastUsedSlug: handle.props.lastUsedOrganization ?? null,
		})
		return (
			<div
				mix={[
					css(accountMenuCss),
					on('keydown', (event: KeyboardEvent) => {
						moveSwitcherFocus(
							event,
							document.getElementById(accountMenuPanelId),
						)
					}),
				]}
			>
				<button
					type="button"
					popovertarget={accountMenuPanelId}
					aria-controls={accountMenuPanelId}
					aria-label={`${name}: your account`}
					aria-expanded={open ? 'true' : 'false'}
					data-open={open ? '' : undefined}
					data-testid="account-menu"
					mix={css(accountMenuButtonCss)}
				>
					<UserAvatar
						displayName={name}
						avatarUrl={handle.props.avatarUrl}
						size={34}
						variant="well"
					/>
				</button>
				<div
					id={accountMenuPanelId}
					popover
					data-testid="account-menu-panel"
					mix={[css(accountMenuPanelCss), on('toggle', onToggle)]}
				>
					<div mix={css(accountMenuIdentityCss)}>
						<span mix={css(switcherRowLabelCss)}>{name}</span>
						{handle.props.username ? (
							<span mix={css(switcherRowDetailCss)}>
								@{handle.props.username}
							</span>
						) : null}
					</div>
					{renderManageGroup({
						links: manageLinks,
						currentPathname: handle.props.currentPathname,
						divided: false,
					})}
					{renderAccountGroup({
						username: handle.props.username,
						currentPathname: handle.props.currentPathname,
						organizations,
						heading: false,
						divided: manageLinks.length > 0,
					})}
				</div>
			</div>
		)
	}
}

export function SiteHeader(handle: Handle<SiteHeaderProps>) {
	let menuOpen = false

	if (typeof document !== 'undefined') {
		// Following a link inside the menu is a client-side navigation, so
		// nothing would otherwise dismiss the panel.
		listenToRouterNavigation(handle, () => {
			dismissOpenPopoverPanel(document.getElementById(menuPanelId))
			dismissOpenPopoverPanel(document.getElementById(accountMenuPanelId))
		})
	}

	// The browser owns open/close (light dismiss, Escape, the invoker); this
	// only mirrors the state the button has to announce and draw.
	function onMenuToggle(event: { newState?: string }) {
		const next = event.newState === 'open'
		if (next === menuOpen) return
		menuOpen = next
		handle.update()
	}

	return () => {
		return (
			<header class="site-header" mix={css(headerCss)}>
				<nav aria-label="Main" mix={css(navCss)}>
					<a href="/" mix={css(brandCss)}>
						<img src="/images/kody-mark.png" alt="" width={34} height={34} />
						<span>Kody</span>
					</a>
					<div mix={css(navLinksCss)}>
						<FeaturesMenu currentPathname={handle.props.currentPathname} />
						{marketingLinks.map((link) => (
							<a
								key={link.href}
								href={link.href}
								aria-current={ariaCurrent(
									handle.props.currentPathname,
									link.href,
								)}
							>
								{link.label}
							</a>
						))}
						{handle.props.showAdminLink ? (
							<a
								href="/admin/users"
								aria-current={ariaCurrent(
									handle.props.currentPathname,
									'/admin/users',
								)}
							>
								Admin
							</a>
						) : null}
					</div>
					<div mix={css(navActionsCss)}>
						{handle.props.loggedIn ? (
							<>
								<AccountMenu
									username={handle.props.username}
									displayName={handle.props.displayName}
									avatarUrl={handle.props.avatarUrl}
									currentPathname={handle.props.currentPathname}
									organizations={handle.props.organizations ?? []}
									lastUsedOrganization={
										handle.props.lastUsedOrganization ?? null
									}
								/>
								{handle.props.showDemoIndicator ? (
									<span
										data-testid="demo-indicator"
										mix={css(demoIndicatorCss)}
									>
										Demo
									</span>
								) : null}
							</>
						) : (
							<a href={handle.props.loginHref} mix={css(navLoginCss)}>
								Log in
							</a>
						)}
					</div>
					<button
						type="button"
						popovertarget={menuPanelId}
						aria-label="Menu"
						aria-expanded={menuOpen ? 'true' : 'false'}
						data-open={menuOpen ? '' : undefined}
						mix={css(menuToggleCss)}
					>
						<span aria-hidden="true" mix={css(burgerCss)}>
							<span />
							<span />
							<span />
						</span>
					</button>
					<div
						id={menuPanelId}
						popover
						mix={[css(menuPanelCss), on('toggle', onMenuToggle)]}
					>
						<div data-menu-group mix={css(menuGroupCss)}>
							<FeaturesMenu
								currentPathname={handle.props.currentPathname}
								mobile
							/>
							{marketingLinks.map((link) => (
								<a
									key={link.href}
									href={link.href}
									aria-current={ariaCurrent(
										handle.props.currentPathname,
										link.href,
									)}
								>
									{link.label}
								</a>
							))}
							{handle.props.showAdminLink ? (
								<a
									href="/admin/users"
									aria-current={ariaCurrent(
										handle.props.currentPathname,
										'/admin/users',
									)}
								>
									Admin
								</a>
							) : null}
						</div>
						{handle.props.loggedIn
							? renderPhoneAccountGroups({
									username: handle.props.username,
									currentPathname: handle.props.currentPathname,
									organizations: handle.props.organizations ?? [],
									lastUsedOrganization:
										handle.props.lastUsedOrganization ?? null,
								})
							: null}
						{handle.props.loggedIn ? null : (
							<div data-menu-group mix={css(menuGroupCss)}>
								<a href={handle.props.loginHref}>Log in</a>
							</div>
						)}
					</div>
				</nav>
			</header>
		)
	}
}

const headerCss = {
	position: 'sticky' as const,
	top: 0,
	zIndex: 10,
	viewTransitionName: 'site-header',
	background: `oklch(from ${colors.background} l c h / 0.85)`,
	'@supports (backdrop-filter: blur(1px))': {
		backdropFilter: 'blur(14px)',
	},
}

const navCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `0.8rem ${pageGutter}`,
	display: 'flex',
	alignItems: 'center',
	gap: '1.8rem',
	'@media (min-width: 821px) and (max-width: 1000px)': { gap: '.8rem' },
	flexWrap: 'wrap' as const,
}

const brandCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.6rem',
	minHeight: '44px',
	font: `700 1.25rem/1 ${typography.fontFamilyDisplay}`,
	color: colors.text,
	textDecoration: 'none',
	letterSpacing: '-0.01em',
	'&:hover': { color: colors.text },
}

const navLinksCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '1.6rem',
	'@media (min-width: 821px) and (max-width: 1000px)': { gap: '.8rem' },
	marginRight: 'auto',
	'& a': {
		color: colors.textMuted,
		textDecoration: 'none',
		fontWeight: 500,
		fontSize: '0.98rem',
		transition: `color ${transitions.fast}`,
	},
	'& a:hover': { color: colors.text },
	'& a[aria-current="page"]': { color: colors.text },
	[headerNavMq]: { display: 'none' },
}

const navActionsCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.9rem',
	// The links are gone at this width, so the actions take the free space
	// and keep the toggle pinned to the right edge.
	[headerNavMq]: { display: 'none' },
}

const menuToggleCss = {
	display: 'none',
	marginLeft: 'auto',
	alignItems: 'center',
	justifyContent: 'center',
	width: '44px',
	height: '44px',
	padding: 0,
	borderRadius: '12px',
	border: `1.5px solid ${colors.border}`,
	background: 'transparent',
	color: colors.text,
	cursor: 'pointer',
	transition: `border-color ${transitions.fast}, background-color ${transitions.fast}, scale ${transitions.fast}`,
	'&:active': { scale: '0.94' },
	[hoverMq]: {
		'&:hover': { borderColor: colors.textMuted },
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&:active': { scale: 'none' },
	},
	[headerNavMq]: { display: 'inline-flex' },
}

/** Three rules that fold into a cross. Transform-only, so it stays composited. */
const burgerCss = {
	display: 'grid',
	gap: '4px',
	width: '18px',
	'& > span': {
		display: 'block',
		height: '2px',
		borderRadius: '2px',
		backgroundColor: 'currentColor',
		transition: `translate 180ms ${transitions.easeOut}, rotate 180ms ${transitions.easeOut}, opacity 120ms ${transitions.easeOut}, scale 120ms ${transitions.easeOut}`,
	},
	// The end state still changes under reduced motion — only the tweening goes.
	'@media (prefers-reduced-motion: reduce)': {
		'& > span': { transition: 'none' },
	},
	'[data-open] &> span:nth-child(1)': { translate: '0 6px', rotate: '45deg' },
	'[data-open] &> span:nth-child(2)': { opacity: 0, scale: '0.4' },
	'[data-open] &> span:nth-child(3)': { translate: '0 -6px', rotate: '-45deg' },
}

/**
 * The menu is a native popover: the top layer, light dismiss, Escape, and
 * focus return all come from the platform, and the entrance is a plain
 * transition thanks to `@starting-style` plus discrete `display`/`overlay`.
 * 180ms, the dropdown budget — this opens often enough that it must not
 * make anyone wait.
 */
const menuPanelCss = {
	position: 'fixed' as const,
	inset: 'auto' as const,
	top: '4.15rem',
	left: pageGutter,
	right: pageGutter,
	width: 'auto',
	maxWidth: 'none',
	maxHeight: 'calc(100dvh - 5.5rem)',
	overflowY: 'auto' as const,
	margin: 0,
	padding: '0.5rem',
	// No base `display`: a closed popover must keep the UA's `display: none`,
	// or the invisible fixed panel keeps swallowing taps where the menu was.
	// The `display … allow-discrete` transition holds `grid` through the exit.
	gap: '0.35rem',
	border: `1.5px solid ${colors.border}`,
	borderRadius: '18px',
	backgroundColor: colors.surface,
	boxShadow: shadows.md,
	color: colors.text,
	opacity: 0,
	translate: '0 -8px',
	scale: '0.98',
	transformOrigin: 'top center',
	transition: `opacity 180ms ${transitions.easeOut}, translate 180ms ${transitions.easeOut}, scale 180ms ${transitions.easeOut}, display 180ms allow-discrete, overlay 180ms allow-discrete`,
	'&:popover-open': {
		display: 'grid',
		opacity: 1,
		translate: '0 0',
		scale: '1',
		'@starting-style': {
			opacity: 0,
			translate: '0 -8px',
			scale: '0.98',
		},
	},
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.4)',
		opacity: 0,
		transition: `opacity 180ms ${transitions.easeOut}, display 180ms allow-discrete, overlay 180ms allow-discrete`,
	},
	'&:popover-open::backdrop': {
		opacity: 1,
		'@starting-style': { opacity: 0 },
	},
	'@media (prefers-reduced-motion: reduce)': {
		translate: 'none',
		scale: 'none',
		transition: `opacity 120ms ${transitions.easeOut}, display 120ms allow-discrete, overlay 120ms allow-discrete`,
	},
	// Desktop never sees it; the inline nav is the menu there. `:popover-open`
	// is repeated so this outranks the open state's `display: grid`.
	'@media (min-width: 821px)': {
		display: 'none',
		'&:popover-open': { display: 'none' },
	},
}

/** Hairline between the menu panel's groups, whichever component draws them. */
const menuGroupDividerCss = {
	'[data-menu-group] + &': {
		marginTop: '0.35rem',
		paddingTop: '0.5rem',
		borderTop: `1px solid ${colors.border}`,
	},
}

const menuGroupCss = {
	display: 'grid',
	gap: '0.15rem',
	...menuGroupDividerCss,
	'& a': {
		display: 'flex',
		alignItems: 'center',
		// Comfortable target on a phone, not a cramped text link.
		minHeight: '44px',
		padding: '0 0.85rem',
		borderRadius: '12px',
		color: colors.text,
		textDecoration: 'none',
		fontWeight: 550,
		fontSize: '1rem',
		transition: `background-color ${transitions.fast}, color ${transitions.fast}`,
	},
	'& a[aria-current="page"]': {
		color: colors.primaryText,
		backgroundColor: colors.primarySoft,
	},
	'& a:active': { backgroundColor: colors.primarySoftest },
	[hoverMq]: {
		'& a:hover': { backgroundColor: colors.primarySoftest },
	},
}

const navLoginCss = {
	fontWeight: 550,
	fontSize: '0.98rem',
	color: colors.text,
	textDecoration: 'none',
	padding: '0.7rem 0.25rem',
	whiteSpace: 'nowrap' as const,
	'&:hover': { color: colors.primaryText },
}

/**
 * Hangs under the trigger with its inline end against the trigger's, so the
 * menu grows into the header instead of past the header's right edge. The
 * nav is a centered 72rem column, and a viewport gutter alone sits outside
 * that column on a 1440px desktop. Anchor positioning pins the end to the
 * trigger and flips when the trigger is against the start edge. Without it,
 * the same inset is the header content's inline end. Native popover, like
 * the site menu: top layer, light dismiss, Escape, and focus return come
 * from the platform.
 */
const headerContentEndInset = `max(${pageGutter}, calc((100% - ${layoutMaxWidths.extended}) / 2 + ${pageGutter}))`

const accountMenuAnchor = '--account-menu'

const accountMenuCss = {
	position: 'relative' as const,
}

const accountMenuButtonCss = {
	anchorName: accountMenuAnchor,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '44px',
	height: '44px',
	padding: 0,
	borderRadius: radius.full,
	border: `1.5px solid ${colors.border}`,
	background: 'transparent',
	cursor: 'pointer',
	transition: `border-color ${transitions.fast}`,
	'&[data-open]': { borderColor: colors.textMuted },
	[hoverMq]: {
		'&:hover': { borderColor: colors.textMuted },
	},
}

const accountMenuIdentityCss = {
	display: 'grid',
	gap: '0.15rem',
	padding: '0.5rem 0.6rem 0.6rem',
	borderBottom: `1px solid ${colors.border}`,
	minWidth: 0,
}

const switcherAccountListCss = {
	display: 'grid',
	gap: '0.1rem',
	paddingTop: '0.35rem',
}

const accountMenuPanelCss = {
	...switcherPanelCss,
	top: '4.15rem',
	right: headerContentEndInset,
	width: 'min(16rem, calc(100vw - 2rem))',
	transformOrigin: 'top right',
	'@supports (anchor-name: --a)': {
		positionAnchor: accountMenuAnchor,
		top: 'anchor(bottom)',
		right: 'anchor(right)',
		left: 'auto',
		marginTop: '0.5rem',
		positionTryFallbacks: 'flip-inline',
	},
}

/** Mobile menu: the avatar menu's rows as one of the menu panel's groups. */
const phoneAccountGroupsCss = {
	display: 'grid',
	...menuGroupDividerCss,
}

const demoIndicatorCss = {
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.medium,
	color: colors.textMuted,
	border: `1px solid ${colors.border}`,
	borderRadius: '0.375rem',
	padding: `0 ${spacing.xs}`,
	lineHeight: 1.6,
	letterSpacing: '0.02em',
	textTransform: 'uppercase' as const,
}
