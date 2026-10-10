import { type Handle, type RemixNode, css } from 'remix/component'
import { listenToRouterNavigation } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { teamOrgManagementItems } from '#client/routes/account-rail.ts'
import { type IconName, renderIcon } from '#universal/icon.tsx'
import { UserAvatar } from '#universal/user-avatar.tsx'
import {
	currentSwitcherSlug,
	orgBillingPath,
	orgIdentity,
	orgRoleLabel,
	orgRoleManagesBilling,
	orgSectionKeysOnPerson,
	orgSettingsPath,
	orgSwitcherEntries,
	orgTeamsPath,
	organizationsWithSignupFallback,
	parseOrgBillingPath,
	parseOrgResourcePath,
	switchOrgPath,
	type OrganizationSummary,
	type OrgSwitcherEntry,
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
	inviteCount?: number
	lastUsedOrganization?: string | null
}

/**
 * Sticky site header from the 2026 landing redesign: brand, marketing nav
 * (Community · Docs · Pricing · Blog), and the session corner: one menu that
 * picks the organization and holds the person's own links. The bottom
 * hairline is a static CSS border so it paints before JS.
 */
const marketingLinks = [
	{ href: '/features', label: 'Features' },
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
const orgSwitcherPanelId = 'org-switcher'

/**
 * Dismiss an open popover panel on client-side navigation. Older browsers
 * throw from `matches(':popover-open')` when the Popover API is unavailable.
 */
export function dismissOpenPopoverPanel(panel: Element | null) {
	if (!panel || typeof (panel as HTMLElement).hidePopover !== 'function') return
	const element = panel as HTMLElement
	if (element.matches(':popover-open')) {
		element.hidePopover()
	}
}

type SwitcherRow = {
	key: string
	href: string
	label: string
	detail: string | null
	ariaCurrent: 'true' | 'page' | undefined
	/** The organization the header is acting in; drawn with a check. */
	selected: boolean
	leading: RemixNode
	badge: string | null
}

function renderSwitcherRow(row: SwitcherRow) {
	return (
		<a
			key={row.key}
			href={row.href}
			aria-current={row.ariaCurrent}
			data-testid={`org-switcher-${row.key}`}
			data-selected={row.selected ? '' : undefined}
			mix={css(switcherRowCss)}
		>
			<span mix={css(switcherLeadingCss)}>{row.leading}</span>
			<span mix={css(switcherRowTextCss)}>
				<span mix={css(switcherRowLabelCss)}>{row.label}</span>
				{row.detail ? (
					<span mix={css(switcherRowDetailCss)}>{row.detail}</span>
				) : null}
			</span>
			{row.badge ? <span mix={css(switcherCountCss)}>{row.badge}</span> : null}
			{row.selected ? (
				<span mix={css(switcherCheckCss)}>
					{renderIcon('check', { size: '1.1rem' })}
				</span>
			) : null}
		</a>
	)
}

function renderIconWell(name: IconName) {
	return (
		<span aria-hidden="true" mix={css(switcherIconWellCss)}>
			{renderIcon(name, { size: '1rem' })}
		</span>
	)
}

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

/** Focus order for the arrow keys: the trigger, then every row in the panel. */
function moveSwitcherFocus(event: KeyboardEvent, panel: HTMLElement | null) {
	if (!panel || !panel.matches(':popover-open')) return
	const rows = Array.from(
		panel.querySelectorAll<HTMLElement>('a[href], button'),
	)
	if (rows.length === 0) return
	const index = rows.indexOf(document.activeElement as HTMLElement)
	const next =
		event.key === 'ArrowDown'
			? rows[(index + 1) % rows.length]
			: event.key === 'ArrowUp'
				? rows[index <= 0 ? rows.length - 1 : index - 1]
				: event.key === 'Home'
					? rows[0]
					: event.key === 'End'
						? rows[rows.length - 1]
						: null
	if (!next) return
	event.preventDefault()
	next.focus()
}

function teamOrgSwitchHref(input: {
	pathname: string
	slug: string
	role: OrganizationSummary['role']
	personal: boolean
	onBillingPage: boolean
	managesBilling: boolean
}) {
	if (input.personal) return switchOrgPath(input.pathname, input.slug)
	// Grant-only collaborators can open the org home, not Settings/Teams.
	if (input.role === null) return `/@${input.slug}`
	if (input.onBillingPage && !input.managesBilling) {
		return orgSettingsPath(input.slug)
	}
	const section = parseOrgResourcePath(input.pathname)?.section
	// Packages and connected agents still key on the person — land on Settings
	// so management stays one click away instead of a bare org home.
	if (section && orgSectionKeysOnPerson(section)) {
		return orgSettingsPath(input.slug)
	}
	const next = switchOrgPath(input.pathname, input.slug)
	// Billing has member:read but not team:read.
	if (input.role === 'billing' && next === orgTeamsPath(input.slug)) {
		return orgSettingsPath(input.slug)
	}
	if (next === `/@${input.slug}`) return orgSettingsPath(input.slug)
	return next
}

/** Prefer the team org already in context; otherwise last-used or first team. */
function manageOrganization(
	organizations: ReadonlyArray<OrganizationSummary>,
	current: OrganizationSummary | undefined,
	lastUsedSlug: string | null | undefined,
) {
	if (current && !current.personal && current.role !== null) return current
	const teams = organizations.filter(
		(org) => !org.personal && org.role !== null,
	)
	if (teams.length === 0) return null
	return teams.find((org) => org.slug === lastUsedSlug) ?? teams[0] ?? null
}

function OrgSwitcher(
	handle: Handle<{
		organizations: Array<OrganizationSummary>
		inviteCount: number
		lastUsedOrganization: string | null
		username: string
		displayName: string
		avatarUrl: string | null
		currentPathname: string
		menu?: boolean
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
		const organizations = organizationsWithSignupFallback({
			organizations: handle.props.organizations,
			username: handle.props.username,
		})
		if (organizations.length === 0) return null
		const viewer = {
			displayName: handle.props.displayName,
			avatarUrl: handle.props.avatarUrl,
		}
		const entries = orgSwitcherEntries(organizations, handle.props.inviteCount)
		const currentSlug = currentSwitcherSlug({
			pathname: handle.props.currentPathname,
			organizations,
			lastUsedSlug: handle.props.lastUsedOrganization,
		})
		const current = organizations.find((org) => org.slug === currentSlug)
		const currentIdentity = current ? orgIdentity(current, viewer) : null
		const label = currentIdentity?.handle ?? 'Organizations'
		const avatarSize = handle.props.menu ? 32 : 28
		const onBillingPage =
			parseOrgBillingPath(handle.props.currentPathname) !== null
		const toRow = (entry: OrgSwitcherEntry): SwitcherRow => {
			switch (entry.kind) {
				case 'create':
					return {
						key: 'create',
						href: routes.accountOrganizationsNew.href(),
						label: 'Create organization',
						detail: null,
						ariaCurrent:
							handle.props.currentPathname ===
							routes.accountOrganizationsNew.href()
								? 'page'
								: undefined,
						selected: false,
						leading: renderIconWell('plus'),
						badge: null,
					}
				case 'invites':
					return {
						key: 'invites',
						href: `${routes.accountOrganizations.href()}#invites`,
						label: 'Invites',
						detail: null,
						ariaCurrent: undefined,
						selected: false,
						leading: renderIconWell('mail'),
						badge: entry.count > 0 ? String(entry.count) : null,
					}
				case 'org': {
					const identity = orgIdentity(entry.org, viewer)
					const role = entry.showRole ? orgRoleLabel(entry.org.role) : null
					const selected = entry.org.slug === currentSlug
					return {
						key: entry.org.slug,
						// Packages and connected agents still belong to the person, so
						// a team org opens its home instead of that section. Billing
						// stays on the section only for roles that manage it.
						href: teamOrgSwitchHref({
							pathname: handle.props.currentPathname,
							slug: entry.org.slug,
							role: entry.org.role,
							personal: entry.org.personal,
							onBillingPage,
							managesBilling: orgRoleManagesBilling(entry.org.role),
						}),
						label: identity.name,
						detail: identity.hasName
							? [identity.handle, role].filter(Boolean).join(' · ')
							: role,
						ariaCurrent: selected ? 'true' : undefined,
						selected,
						leading: (
							<UserAvatar
								displayName={identity.avatarName}
								avatarUrl={identity.avatarUrl}
								size={avatarSize}
								variant="well"
							/>
						),
						badge: null,
					}
				}
				default: {
					const exhaustive: never = entry
					return exhaustive
				}
			}
		}
		const orgRows = entries.filter((entry) => entry.kind === 'org').map(toRow)
		// Prefer the team org in context so Settings/Members/… stay one click
		// away from account pages. Fall back to last-used / first team org.
		// Personal-only sessions still get Billing for the signup org.
		const manageOrg = manageOrganization(
			organizations,
			current,
			handle.props.lastUsedOrganization,
		)
		const manageIdentity = manageOrg ? orgIdentity(manageOrg, viewer) : null
		const manageItems = manageOrg
			? teamOrgManagementItems({
					orgSlug: manageOrg.slug,
					role: manageOrg.role,
				})
			: current && orgRoleManagesBilling(current.role)
				? [
						{
							href: orgBillingPath(current.slug),
							label: 'Billing',
							icon: 'wallet' as const,
						},
					]
				: []
		const manageDetailHandle =
			manageIdentity?.handle ?? currentIdentity?.handle ?? null
		const manageRows: Array<SwitcherRow> =
			manageDetailHandle && manageItems.length > 0
				? manageItems.map((item) => ({
						key: `org-manage-${item.label.toLowerCase()}`,
						href: item.href,
						label: item.label,
						detail: manageDetailHandle,
						ariaCurrent:
							handle.props.currentPathname === item.href
								? ('page' as const)
								: undefined,
						selected: false,
						leading: renderIconWell(item.icon),
						badge: null,
					}))
				: []
		const actionRows = entries
			.filter((entry) => entry.kind !== 'org')
			.map(toRow)
		const pageCurrent = (href: string) =>
			handle.props.currentPathname === href ? ('page' as const) : undefined
		const accountRows: Array<SwitcherRow> = [
			...(handle.props.username
				? [
						{
							key: 'account-profile',
							href: routes.profile.href({ username: handle.props.username }),
							label: 'Your profile',
							detail: null,
							ariaCurrent: undefined,
							selected: false,
							leading: renderIconWell('globe'),
							badge: null,
						},
					]
				: []),
			{
				key: 'account-settings',
				href: routes.account.href(),
				label: 'Account settings',
				detail: null,
				ariaCurrent: pageCurrent(routes.account.href()),
				selected: false,
				leading: renderIconWell('user'),
				badge: null,
			},
		]

		const body = (
			<>
				<p mix={css(switcherEyebrowCss)}>Organizations</p>
				<ul aria-label="Organizations" mix={css(switcherListCss)}>
					{orgRows.map((row) => (
						<li key={row.key}>{renderSwitcherRow(row)}</li>
					))}
				</ul>
				{manageRows.length > 0 && manageDetailHandle ? (
					<div
						role="group"
						aria-label={`Manage ${manageDetailHandle}`}
						data-testid="org-switcher-manage-group"
						mix={css(switcherActionsCss)}
					>
						<p mix={css(switcherEyebrowCss)}>Manage {manageDetailHandle}</p>
						{manageRows.map(renderSwitcherRow)}
					</div>
				) : null}
				{actionRows.length > 0 ? (
					<div mix={css(switcherActionsCss)}>
						{actionRows.map(renderSwitcherRow)}
					</div>
				) : null}
				<div
					role="group"
					aria-label="Your account"
					data-testid="org-switcher-account-group"
					mix={css(switcherActionsCss)}
				>
					<p mix={css(switcherEyebrowCss)}>Your account</p>
					{accountRows.map(renderSwitcherRow)}
					{renderLogoutRow()}
				</div>
			</>
		)

		if (handle.props.menu) {
			return (
				<div
					data-menu-group
					data-testid="org-switcher-menu"
					mix={css(switcherMenuGroupCss)}
				>
					{body}
				</div>
			)
		}

		return (
			<div
				mix={[
					css(orgSwitcherCss),
					on('keydown', (event: KeyboardEvent) => {
						moveSwitcherFocus(
							event,
							document.getElementById(orgSwitcherPanelId),
						)
					}),
				]}
			>
				<button
					type="button"
					popovertarget={orgSwitcherPanelId}
					aria-controls={orgSwitcherPanelId}
					aria-label={
						manageRows.length > 0
							? `${label}: organizations, manage, and account`
							: `${label}: organizations and account`
					}
					aria-expanded={open ? 'true' : 'false'}
					data-open={open ? '' : undefined}
					data-testid="org-switcher"
					mix={css(orgSwitcherButtonCss)}
				>
					<UserAvatar
						displayName={currentIdentity?.avatarName ?? label}
						avatarUrl={currentIdentity?.avatarUrl ?? null}
						size={26}
						variant="well"
					/>
					<span mix={css(orgSwitcherLabelCss)}>{label}</span>
					<span aria-hidden="true" mix={css(orgSwitcherChevronCss)}>
						{renderIcon('chevron-down', { size: '1rem' })}
					</span>
				</button>
				<div
					id={orgSwitcherPanelId}
					popover
					data-testid="org-switcher-panel"
					mix={[css(orgSwitcherPanelCss), on('toggle', onToggle)]}
				>
					{body}
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
			dismissOpenPopoverPanel(document.getElementById(orgSwitcherPanelId))
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
								<OrgSwitcher
									organizations={handle.props.organizations ?? []}
									inviteCount={handle.props.inviteCount ?? 0}
									lastUsedOrganization={
										handle.props.lastUsedOrganization ?? null
									}
									username={handle.props.username}
									displayName={handle.props.displayName}
									avatarUrl={handle.props.avatarUrl}
									currentPathname={handle.props.currentPathname}
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
						{handle.props.loggedIn ? (
							<OrgSwitcher
								organizations={handle.props.organizations ?? []}
								inviteCount={handle.props.inviteCount ?? 0}
								lastUsedOrganization={handle.props.lastUsedOrganization ?? null}
								username={handle.props.username}
								displayName={handle.props.displayName}
								avatarUrl={handle.props.avatarUrl}
								currentPathname={handle.props.currentPathname}
								menu
							/>
						) : null}
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

/**
 * Below this the inline nav and session corner would crowd the brand, so both
 * fold into the menu panel. Wider than the mobile token: it is the width the
 * links themselves stop fitting, not a device class.
 */
const headerNavMq = '@media (max-width: 820px)'

const navLinksCss = {
	display: 'flex',
	gap: '1.6rem',
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

/** The trigger names this; the panel positions against it (CSS anchor positioning). */
const orgSwitcherAnchor = '--org-switcher'

const orgSwitcherCss = {
	position: 'relative' as const,
}

const orgSwitcherButtonCss = {
	anchorName: orgSwitcherAnchor,
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.45rem',
	minHeight: '44px',
	padding: '0.2rem 0.6rem 0.2rem 0.2rem',
	borderRadius: radius.full,
	border: `1.5px solid ${colors.border}`,
	background: 'transparent',
	color: colors.text,
	// Buttons do not inherit the page face on their own.
	font: `600 0.95rem/1 ${typography.fontFamily}`,
	cursor: 'pointer',
	transition: `border-color ${transitions.fast}, background-color ${transitions.fast}`,
	'&[data-open]': {
		borderColor: colors.textMuted,
		backgroundColor: colors.surface,
	},
	[hoverMq]: {
		'&:hover': { borderColor: colors.textMuted },
	},
}

const orgSwitcherLabelCss = {
	maxWidth: '14rem',
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const orgSwitcherChevronCss = {
	display: 'inline-flex',
	color: colors.textMuted,
	transition: `rotate 180ms ${transitions.easeOut}`,
	'[data-open] > &': { rotate: '180deg' },
	'@media (prefers-reduced-motion: reduce)': { transition: 'none' },
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

const orgSwitcherPanelCss = {
	position: 'fixed' as const,
	inset: 'auto' as const,
	top: '4.15rem',
	right: headerContentEndInset,
	width: 'min(20rem, calc(100vw - 2rem))',
	maxHeight: 'calc(100dvh - 6rem)',
	overflowY: 'auto' as const,
	margin: 0,
	padding: '0.5rem',
	boxSizing: 'border-box' as const,
	border: `1.5px solid ${colors.border}`,
	borderRadius: '18px',
	backgroundColor: colors.surface,
	boxShadow: shadows.md,
	color: colors.text,
	'@supports (anchor-name: --a)': {
		positionAnchor: orgSwitcherAnchor,
		top: 'anchor(bottom)',
		right: 'anchor(right)',
		left: 'auto',
		marginTop: '0.5rem',
		positionTryFallbacks: 'flip-inline',
	},
	opacity: 0,
	translate: '0 -6px',
	transformOrigin: 'top right',
	transition: `opacity 160ms ${transitions.easeOut}, translate 160ms ${transitions.easeOut}, display 160ms allow-discrete, overlay 160ms allow-discrete`,
	'&:popover-open': {
		display: 'grid',
		opacity: 1,
		translate: '0 0',
		'@starting-style': { opacity: 0, translate: '0 -6px' },
	},
	'@media (prefers-reduced-motion: reduce)': {
		translate: 'none',
		transition: `opacity 120ms ${transitions.easeOut}, display 120ms allow-discrete, overlay 120ms allow-discrete`,
	},
}

const switcherEyebrowCss = {
	margin: 0,
	padding: '0.35rem 0.6rem 0.3rem',
	[headerNavMq]: { paddingInline: '0.85rem' },
	fontSize: typography.fontSize.xs,
	fontWeight: 650,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const switcherListCss = {
	display: 'grid',
	gap: '0.15rem',
	listStyle: 'none',
	margin: 0,
	padding: 0,
}

const switcherActionsCss = {
	display: 'grid',
	gap: '0.15rem',
	marginTop: '0.35rem',
	paddingTop: '0.4rem',
	borderTop: `1px solid ${colors.border}`,
}

/** Mobile menu: the same rows as one of the menu panel's groups. */
const switcherMenuGroupCss = {
	display: 'grid',
	...menuGroupDividerCss,
}

const switcherRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.7rem',
	minHeight: '44px',
	padding: '0.4rem 0.6rem',
	[headerNavMq]: { paddingInline: '0.85rem' },
	boxSizing: 'border-box' as const,
	borderRadius: '12px',
	color: colors.text,
	textDecoration: 'none',
	transition: `background-color ${transitions.fast}`,
	'&[aria-current="page"]': { backgroundColor: colors.primarySoft },
	'&:active': { backgroundColor: colors.primarySoftest },
	[hoverMq]: {
		'&:hover': { backgroundColor: colors.primarySoftest, color: colors.text },
	},
}

const switcherButtonRowCss = {
	...switcherRowCss,
	width: '100%',
	border: 'none',
	background: 'transparent',
	font: 'inherit',
	textAlign: 'start' as const,
	cursor: 'pointer',
}

const switcherLeadingCss = {
	display: 'inline-flex',
	flexShrink: 0,
	lineHeight: 0,
}

const switcherIconWellCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '28px',
	height: '28px',
	boxSizing: 'border-box' as const,
	borderRadius: radius.full,
	border: `1px dashed ${colors.border}`,
	color: colors.textMuted,
	[headerNavMq]: { width: '32px', height: '32px' },
}

const switcherRowTextCss = {
	display: 'grid',
	gap: '0.1rem',
	minWidth: 0,
	flex: '1 1 auto',
}

const switcherRowLabelCss = {
	fontWeight: 600,
	fontSize: '0.95rem',
	lineHeight: 1.25,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
	[headerNavMq]: { fontSize: '1rem' },
}

const switcherRowDetailCss = {
	fontSize: typography.fontSize.sm,
	lineHeight: 1.25,
	color: colors.textMuted,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const switcherCountCss = {
	flexShrink: 0,
	minWidth: '1.4rem',
	padding: '0.1rem 0.45rem',
	boxSizing: 'border-box' as const,
	borderRadius: radius.full,
	backgroundColor: colors.primary,
	color: colors.onPrimary,
	fontSize: typography.fontSize.xs,
	fontWeight: 700,
	textAlign: 'center' as const,
	fontVariantNumeric: 'tabular-nums',
}

const switcherCheckCss = {
	display: 'inline-flex',
	flexShrink: 0,
	color: colors.primaryText,
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
