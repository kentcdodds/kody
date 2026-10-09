import { css, ref, type Handle } from 'remix/component'
import { routerEvents } from '#client/client-router.tsx'
import { renderIcon, type IconName } from '#universal/icon.tsx'
import { colors, transitions } from '#universal/styles/tokens.ts'
import { hoverMq, pageGutter } from '#universal/styles/style-primitives.ts'

/** Account nav collapses to a wrapping row below this width (prototype 860px). */
export const accountManagementNarrowMq = '@media (max-width: 860px)'

type AccountManagementLinkNavItem = {
	href: string
	label: string
	active: boolean
	icon?: IconName
}

type AccountManagementLinkNavGroup = {
	label: string | null
	items: Array<AccountManagementLinkNavItem>
}

type AccountManagementLinkNavProps = {
	label: string
	/** Names whose settings these are: "Account", or "Workspace" plus `@slug`. */
	heading?: { eyebrow: string; name?: string }
	groups: Array<AccountManagementLinkNavGroup>
}

type AccountManagementInlineLinkNavProps = {
	label: string
	items: Array<AccountManagementLinkNavItem>
}

/** Set on the shell so it is at least as tall as the rail's link column. */
export const accountRailHeightVar = '--account-rail-height'

const railHeadingCss = {
	display: 'grid',
	gap: '0.1rem',
	padding: '0 0.7rem 0.6rem',
	margin: 0,
	minWidth: 0,
}

const railEyebrowCss = {
	fontSize: '0.72rem',
	fontWeight: 650,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const railNameCss = {
	fontWeight: 650,
	fontSize: '0.98rem',
	color: colors.text,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const railGroupLabelCss = {
	margin: 0,
	padding: '0.85rem 0.7rem 0.3rem',
	fontSize: '0.72rem',
	fontWeight: 650,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const railGroupCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.15rem',
}

function renderRailHeading(heading: AccountManagementLinkNavProps['heading']) {
	if (!heading) return null
	return (
		<p mix={css(railHeadingCss)} data-account-nav-heading>
			<span mix={css(railEyebrowCss)}>{heading.eyebrow}</span>
			{heading.name ? <span mix={css(railNameCss)}>{heading.name}</span> : null}
		</p>
	)
}

function renderRailGroups(
	groups: Array<AccountManagementLinkNavGroup>,
	linkCss: Parameters<typeof css>[0],
) {
	return groups.map((group, index) => (
		<div
			key={group.label ?? `group-${index}`}
			role={group.label ? 'group' : undefined}
			aria-label={group.label ?? undefined}
			mix={css(railGroupCss)}
		>
			{group.label ? (
				<p aria-hidden="true" mix={css(railGroupLabelCss)}>
					{group.label}
				</p>
			) : null}
			{renderAccountNavLinks(group.items, linkCss)}
		</div>
	))
}

/** `.account-nav a` — quiet link pills; only the current one goes green. */
const accountNavLinkCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.5rem',
	padding: '0.5rem 0.7rem',
	borderRadius: '10px',
	color: colors.textMuted,
	fontWeight: 550,
	fontSize: '0.98rem',
	textDecoration: 'none',
	transition: `color ${transitions.fast}, background-color ${transitions.fast}`,
	'& [data-icon]': {
		flex: 'none',
	},
	[hoverMq]: {
		'&:hover': { color: colors.text, backgroundColor: colors.surface },
	},
	'&[aria-current]': {
		color: colors.primaryText,
		backgroundColor: colors.primarySoft,
	},
}

const accountMobileNavLinkCss = {
	...accountNavLinkCss,
	display: 'flex',
	alignItems: 'center',
	minHeight: '44px',
	padding: '0.55rem 0.75rem',
	borderRadius: '0.45rem',
}

const accountMobileMenuCss = {
	display: 'none',
	border: `1px solid ${colors.border}`,
	borderRadius: '0.75rem',
	background: colors.surface,
	'& > summary': {
		display: 'flex',
		alignItems: 'center',
		gap: '0.6rem',
		minHeight: '44px',
		padding: '0.7rem 1rem',
		cursor: 'pointer',
		fontWeight: 650,
		color: colors.text,
		listStyle: 'none',
	},
	'& > summary::-webkit-details-marker': { display: 'none' },
	'& > summary::marker': { content: '""' },
	'& > summary [data-icon]': {
		flex: 'none',
		color: colors.textMuted,
	},
	'& > nav': {
		display: 'grid',
		gap: '0.15rem',
		padding: '0.4rem 0.6rem 0.7rem',
		borderTop: `1px solid ${colors.border}`,
	},
	[accountManagementNarrowMq]: {
		display: 'block',
	},
}

const accountMobileMenuCurrentCss = {
	color: colors.textMuted,
	fontWeight: 500,
	fontSize: '0.9rem',
}

function renderAccountNavLinks(
	items: Array<AccountManagementLinkNavItem>,
	linkCss: Parameters<typeof css>[0],
) {
	return items.map((item) => (
		<a
			key={item.href}
			href={item.href}
			aria-current={item.active ? 'page' : undefined}
			mix={css(linkCss)}
		>
			{item.icon ? renderIcon(item.icon, { size: '1.05em' }) : null}
			{item.label}
		</a>
	))
}

export function AccountManagementLinkNav(
	handle: Handle<AccountManagementLinkNavProps>,
) {
	return () => {
		const current = handle.props.groups
			.flatMap((group) => group.items)
			.find((item) => item.active)
		return (
			<>
				<nav
					aria-label={handle.props.label}
					data-account-nav
					mix={css({
						// Prototype `.account-nav`: a 200px rail beside the
						// content. The nav fills the shell's left track (top
						// and bottom), so it runs down to the footer and cannot
						// paint over it. `overflow: clip`
						// hides any link that would spill out without becoming
						// a scroll container, which would trap the sticky
						// column below. Named so a view transition lifts it out
						// of `<main>` / `page`. Intra-shell tab clicks skip VT.
						// Leaving/entering the shell fades this name
						// (styles.css) so the old rail is not pinned as a ghost
						// on the destination. The group stays still so
						// account↔admin (rail on both sides) does not morph.
						// Below 860px the rail hides and the details menu below
						// takes over — wrapping twelve pills ate a screen of
						// vertical room on a phone.
						position: 'absolute',
						left: pageGutter,
						top: 0,
						bottom: 0,
						width: '200px',
						overflow: 'clip',
						viewTransitionName: 'account-nav',
						[accountManagementNarrowMq]: {
							display: 'none',
						},
					})}
				>
					<div
						mix={[
							css({
								// Sticks under the site header on a long page. The
								// shell is held at least this tall (see the ref), so
								// only a viewport shorter than the list makes it
								// scroll inside the rail.
								position: 'sticky',
								top: '5rem',
								display: 'flex',
								flexDirection: 'column',
								gap: '0.15rem',
								maxHeight: 'min(100%, calc(100dvh - 6.5rem))',
								overflowY: 'auto',
								overscrollBehavior: 'contain',
							}),
							ref((node, signal) => {
								if (!(node instanceof HTMLElement)) return
								const shell = node.closest<HTMLElement>('[data-account-shell]')
								if (!shell || typeof ResizeObserver === 'undefined') return
								const sync = () => {
									shell.style.setProperty(
										accountRailHeightVar,
										`${node.scrollHeight}px`,
									)
								}
								const observer = new ResizeObserver(sync)
								observer.observe(node)
								sync()
								signal.addEventListener('abort', () => {
									observer.disconnect()
									shell.style.removeProperty(accountRailHeightVar)
								})
							}),
						]}
					>
						{renderRailHeading(handle.props.heading)}
						{renderRailGroups(handle.props.groups, accountNavLinkCss)}
					</div>
				</nav>
				<details
					mix={[
						css(accountMobileMenuCss),
						ref((node, signal) => {
							if (!(node instanceof HTMLDetailsElement)) return
							const close = () => {
								node.open = false
							}
							routerEvents.addEventListener('navigate', close, { signal })
						}),
					]}
				>
					<summary>
						{renderIcon('menu', { size: '1.05em' })}
						<span>
							{handle.props.heading?.name ??
								handle.props.heading?.eyebrow ??
								handle.props.label}
						</span>
						{current ? (
							<span mix={css(accountMobileMenuCurrentCss)}>
								{current.label}
							</span>
						) : null}
					</summary>
					<nav aria-label={handle.props.label}>
						{renderRailGroups(handle.props.groups, accountMobileNavLinkCss)}
					</nav>
				</details>
			</>
		)
	}
}

/**
 * In-flow pill row for filters and other secondary link sets. Do not use
 * `AccountManagementLinkNav` for this — that component is the unique
 * `[data-account-nav]` rail the shell absolutely positions, so a second
 * instance stacks on top of the admin/account sections.
 */
export function AccountManagementInlineLinkNav(
	handle: Handle<AccountManagementInlineLinkNavProps>,
) {
	return () => (
		<nav
			aria-label={handle.props.label}
			mix={css({
				display: 'flex',
				flexWrap: 'wrap',
				alignItems: 'center',
				gap: '0.3rem',
			})}
		>
			{handle.props.items.map((item) => (
				<a
					key={item.href}
					href={item.href}
					aria-current={item.active ? 'page' : undefined}
					mix={css(accountMobileNavLinkCss)}
				>
					{item.label}
				</a>
			))}
		</nav>
	)
}
