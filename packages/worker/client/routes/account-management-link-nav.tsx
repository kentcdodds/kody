import { css, ref, type Handle } from 'remix/ui'
import { routerEvents } from '#client/client-router.tsx'
import { colors, transitions } from '#universal/styles/tokens.ts'
import { hoverMq, pageGutter } from '#universal/styles/style-primitives.ts'

/** Account nav collapses to a wrapping row below this width (prototype 860px). */
export const accountManagementNarrowMq = '@media (max-width: 860px)'

type AccountManagementLinkNavItem = {
	href: string
	label: string
	active: boolean
}

type AccountManagementLinkNavProps = {
	label: string
	items: Array<AccountManagementLinkNavItem>
}

/** `.account-nav a` — quiet link pills; only the current one goes green. */
const accountNavLinkCss = {
	padding: '0.5rem 0.9rem',
	borderRadius: '10px',
	color: colors.textMuted,
	fontWeight: 550,
	fontSize: '0.98rem',
	textDecoration: 'none',
	transition: `color ${transitions.fast}, background-color ${transitions.fast}`,
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
	'& > summary::before': {
		content: '"☰"',
		color: colors.textMuted,
		fontSize: '0.95rem',
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
			{item.label}
		</a>
	))
}

export function AccountManagementLinkNav(
	handle: Handle<AccountManagementLinkNavProps>,
) {
	return () => {
		const current = handle.props.items.find((item) => item.active)
		return (
			<>
				<nav
					aria-label={handle.props.label}
					data-account-nav
					mix={css({
						// Prototype `.account-nav`: a 200px rail beside the
						// content. The nav fills the shell's absolute left track
						// (full height, so the sticky inner column has the whole
						// page to stick through). Named so a view transition
						// lifts it out of `<main>` / `page`. Intra-shell tab
						// clicks skip VT. Leaving/entering the shell fades this
						// name (styles.css) so the old rail is not pinned as a
						// ghost on the destination. The group stays still so
						// account↔admin (rail on both sides) does not morph.
						// Below 860px the rail hides and the details menu below
						// takes over — wrapping twelve pills ate a screen of
						// vertical room on a phone.
						position: 'absolute',
						left: pageGutter,
						top: 0,
						bottom: 0,
						width: '200px',
						viewTransitionName: 'account-nav',
						[accountManagementNarrowMq]: {
							display: 'none',
						},
					})}
				>
					<div
						mix={css({
							position: 'sticky',
							top: '5rem',
							display: 'flex',
							flexDirection: 'column',
							gap: '0.15rem',
						})}
					>
						{renderAccountNavLinks(handle.props.items, accountNavLinkCss)}
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
						<span>{handle.props.label}</span>
						{current ? (
							<span mix={css(accountMobileMenuCurrentCss)}>
								{current.label}
							</span>
						) : null}
					</summary>
					<nav aria-label={handle.props.label}>
						{renderAccountNavLinks(handle.props.items, accountMobileNavLinkCss)}
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
	handle: Handle<AccountManagementLinkNavProps>,
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
