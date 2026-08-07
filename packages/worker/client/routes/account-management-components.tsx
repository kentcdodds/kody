import { css, type Handle } from 'remix/ui'
import { routes } from '#app/routes.ts'
import { on } from '#client/event-mixin.ts'
import { shouldRouterHandleClick } from '#client/client-router.tsx'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from '#client/styles/tokens.ts'
import {
	getAuthInputCss,
	getSurfaceCardCss,
	hoverMq,
	layoutMaxWidths,
	pageGutter,
} from '#client/styles/style-primitives.ts'

/*
 * Account-area visual language, ported from the redesign prototype
 * (`landing/account.html` + the `.account-*` blocks in `landing/styles.css`).
 * Sections are hairline-divided (no card chrome), headings speak in the
 * display face, ledes are muted and measured, and nav links are quiet pills
 * that only go green when current.
 */

/** `.account-section` — hairline-topped section, no card chrome. */
export const accountSectionCss = {
	borderTop: `1px solid ${colors.border}`,
	paddingTop: 'clamp(2rem, 4vw, 2.75rem)',
	scrollMarginTop: '5.5rem',
	display: 'grid',
	gap: spacing.md,
}

/** `.account-section h2` — display face, quiet weight. */
export const accountSectionTitleCss = {
	margin: 0,
	fontSize: '1.35rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	color: colors.text,
	lineHeight: 1.2,
}

/** `.account-section > p` — muted lede with a reading measure. */
export const accountSectionLedeCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.98rem',
	maxWidth: '60ch',
	textWrap: 'balance' as const,
}

/** `.field` */
export const accountFieldCss = {
	display: 'grid',
	gap: '0.45rem',
	minWidth: 0,
}

/** `.field label` */
export const accountFieldLabelCss = {
	fontSize: '0.92rem',
	fontWeight: 600,
	color: colors.text,
}

/** `.field input` — the shared auth-field treatment (green border + glow on
 * focus). Inputs must carry `data-field-ring` so the unlayered global
 * `:focus-visible` outline stands down. */
export const accountInputCss = {
	...getAuthInputCss(),
	maxWidth: '100%',
}

export const accountTextareaCss = {
	...accountInputCss,
	resize: 'vertical' as const,
	minHeight: '7rem',
}

/** `.field-note` */
export const accountFieldNoteCss = {
	margin: 0,
	fontSize: '0.92rem',
	color: colors.textMuted,
}

/** `.verified` — the little green status pill next to the account email. */
export const verifiedPillCss = {
	display: 'inline-block',
	fontSize: '0.8rem',
	fontWeight: 600,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
	borderRadius: radius.full,
	padding: '0.1rem 0.55rem',
	marginLeft: '0.3rem',
}

/** `.account-actions` — wrapping row of small pill/ghost actions. */
export const accountActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.7rem',
}

/** `.account-more` — quiet green disclosure ("Change email"). */
export const accountDisclosureCss = {
	'& > summary': {
		cursor: 'pointer',
		fontWeight: 600,
		color: colors.primaryText,
		width: 'fit-content',
		transition: `color ${transitions.fast}`,
	},
	[hoverMq]: {
		'& > summary:hover': { color: colors.text },
	},
	'&[open] > summary': { marginBottom: '0.4rem' },
	'& > :not(summary)': {
		'@media (prefers-reduced-motion: no-preference)': {
			transition: `opacity 200ms ${transitions.easeOut}, translate 200ms ${transitions.easeOut}`,
		},
		'@starting-style': {
			opacity: 0,
			translate: '0 4px',
		},
	},
}

type AccountManagementSlot = any

type AccountManagementLinkNavItem = {
	href: string
	label: string
	active: boolean
}

type AccountManagementShellProps = {
	/**
	 * Optional cap on the content column (not the whole grid). Useful for
	 * pages whose forms read better on a narrower measure.
	 */
	maxWidth?: string
	children: AccountManagementSlot
}

/** Account nav collapses to a wrapping row below this width (prototype 860px). */
export const accountManagementNarrowMq = '@media (max-width: 860px)'
const accountNavMq = accountManagementNarrowMq

/**
 * List/detail panes need more room than the nav rail. Between the nav collapse
 * and this width the 200px rail is still out, so two content columns crush.
 */
export const accountManagementStackMq = '@media (max-width: 1100px)'

/** Prototype `.account` section rhythm: margin between blocks in the content column. */
const accountSectionGap = 'clamp(2rem, 4vw, 2.75rem)'

export function AccountManagementShell(
	handle: Handle<AccountManagementShellProps>,
) {
	return () => (
		<section
			data-account-shell
			mix={css({
				maxWidth: layoutMaxWidths.extended,
				margin: '0 auto',
				// Prototype `.account` padding. The inline gutter is the one every
				// other page container carries, so the content column lines up
				// with the header's 72rem content box instead of running wider
				// than the nav above it; the bottom clamp keeps the last section
				// off the footer hairline. `<main>`'s generic padding is zeroed
				// for this shell in public/styles.css so the two don't stack.
				padding: `clamp(2rem, 5vw, 3.5rem) ${pageGutter} clamp(3rem, 7vw, 5rem)`,
				boxSizing: 'border-box' as const,
				display: 'grid',
				gap: spacing.xl,
				alignItems: 'start',
				// Prototype `.account` layout: 200px sticky nav rail beside the
				// content column, 72rem total. The rail is an absolutely
				// positioned full-height track (so the content keeps its normal
				// single-column flow and gap) and only exists when the section
				// nav is present — nav-less shell users (onboarding, pending
				// verification) keep the plain column. The rail starts at the
				// gutter so it lines up with the header's brand. Note: `css()` classes
				// each live in their own cascade sub-layer, so child spacing
				// must stay on the shell's `gap`, never on per-child margins a
				// child's own class would silently beat.
				'&:has(> [data-account-nav])': {
					position: 'relative',
					gap: accountSectionGap,
					paddingLeft: `calc(${pageGutter} + 200px + clamp(2rem, 5vw, 4.5rem))`,
					// The absolute rail contributes no height; keep room so a
					// short page never lets the nav spill over the footer.
					minHeight: '40rem',
					...(handle.props.maxWidth
						? {
								'& > *:not([data-account-nav])': {
									maxWidth: handle.props.maxWidth,
								},
							}
						: {}),
					[accountNavMq]: {
						paddingLeft: pageGutter,
						minHeight: 0,
						gap: spacing.xl,
					},
				},
				...(handle.props.maxWidth
					? {
							'&:not(:has(> [data-account-nav]))': {
								maxWidth: handle.props.maxWidth,
							},
						}
					: {}),
			})}
		>
			{handle.props.children}
		</section>
	)
}

type AccountManagementHeaderProps = {
	title: string
	description: string
	actions?: AccountManagementSlot
}

export function AccountManagementHeader(
	handle: Handle<AccountManagementHeaderProps>,
) {
	return () => (
		<header
			mix={css({
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'flex-start',
				gap: spacing.md,
				flexWrap: 'wrap',
			})}
		>
			<div mix={css({ display: 'grid', gap: '0.6rem' })}>
				<h1
					mix={css({
						fontSize: 'clamp(2rem, 4vw, 2.7rem)',
						fontWeight: 760,
						letterSpacing: '-0.026em',
						lineHeight: 1.08,
						color: colors.text,
						margin: 0,
					})}
				>
					{handle.props.title}
				</h1>
				<p mix={css({ color: colors.textMuted, margin: 0 })}>
					{handle.props.description}
				</p>
			</div>
			{handle.props.actions ? (
				<div
					mix={css({
						display: 'flex',
						gap: spacing.sm,
						flexWrap: 'wrap',
					})}
				>
					{handle.props.actions}
				</div>
			) : null}
		</header>
	)
}

const adminNavItems = [
	{ href: '/admin/users', label: 'Users', paths: ['/admin', '/admin/users'] },
	{ href: '/admin/insights', label: 'Insights', paths: ['/admin/insights'] },
	{ href: '/admin/invites', label: 'Invites', paths: ['/admin/invites'] },
	{
		href: '/admin/feature-flags',
		label: 'Feature flags',
		paths: ['/admin/feature-flags'],
	},
	{
		href: '/admin/codemods',
		label: 'Codemods',
		paths: ['/admin/codemods'],
	},
	{ href: '/admin/roles', label: 'Roles', paths: ['/admin/roles'] },
	{
		href: '/admin/community-reports',
		label: 'Community reports',
		paths: ['/admin/community-reports'],
	},
	{
		href: routes.adminPlatformFeedback.href(),
		label: 'Platform feedback',
		paths: [routes.adminPlatformFeedback.href()],
	},
	{
		href: '/admin/system-email',
		label: 'System email',
		paths: ['/admin/system-email'],
	},
] as const

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

export function AccountManagementLinkNav(
	handle: Handle<AccountManagementLinkNavProps>,
) {
	return () => (
		<nav
			aria-label={handle.props.label}
			data-account-nav
			mix={css({
				// Prototype `.account-nav`: a 200px rail beside the content.
				// The nav fills the shell's absolute left track (full height,
				// so the sticky inner column has the whole page to stick
				// through); below 860px it returns to flow as a wrapping row.
				position: 'absolute',
				left: pageGutter,
				top: 0,
				bottom: 0,
				width: '200px',
				[accountNavMq]: {
					position: 'static',
					width: 'auto',
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
					[accountNavMq]: {
						position: 'static',
						flexDirection: 'row',
						flexWrap: 'wrap',
						gap: '0.3rem',
					},
				})}
			>
				{handle.props.items.map((item) => (
					<a
						key={item.href}
						href={item.href}
						aria-current={item.active ? 'page' : undefined}
						mix={css(accountNavLinkCss)}
					>
						{item.label}
					</a>
				))}
			</div>
		</nav>
	)
}

const accountNavItems = [
	{ href: '/account', label: 'Overview' },
	{ href: '/account/billing', label: 'Billing' },
	{ href: '/account/usage', label: 'Usage' },
	{ href: '/account/activity', label: 'Activity' },
	{ href: '/account/packages', label: 'Packages' },
	{ href: '/account/jobs', label: 'Jobs' },
	{ href: '/account/stars', label: 'Stars' },
	{ href: '/account/secrets', label: 'Secrets' },
	{ href: '/account/values', label: 'Values' },
	{ href: '/account/integrations', label: 'Integrations' },
	{ href: '/account/package-invocation-tokens', label: 'Package tokens' },
	{ href: '/account/remote-connectors', label: 'Connectors' },
	{ href: '/account/mcp-servers', label: 'MCP servers' },
	{ href: '/account/memories', label: 'Memories' },
	{ href: '/account/email', label: 'Email' },
] as const

function isAccountNavItemActive(itemHref: string, currentPath: string) {
	if (itemHref === '/account') return currentPath === '/account'
	return currentPath === itemHref || currentPath.startsWith(`${itemHref}/`)
}

type AccountPageHeaderProps = {
	title: string
	description: string
	currentHref: string
	actions?: AccountManagementSlot
}

/**
 * Header plus the account-sections subnav. Account pages use this the same
 * way admin pages use AdminPageHeader, so user-specific destinations live
 * under the account layout instead of crowding the top-level nav.
 */
export function AccountPageHeader(handle: Handle<AccountPageHeaderProps>) {
	return () => {
		const currentPath = new URL(handle.props.currentHref, 'http://localhost')
			.pathname

		return (
			<>
				<AccountManagementHeader
					title={handle.props.title}
					description={handle.props.description}
					actions={handle.props.actions}
				/>
				<AccountManagementLinkNav
					label="Account sections"
					items={accountNavItems.map((item) => ({
						href: item.href,
						label: item.label,
						active: isAccountNavItemActive(item.href, currentPath),
					}))}
				/>
			</>
		)
	}
}

type AdminPageHeaderProps = {
	title: string
	description: string
	currentHref: string
}

export function AdminPageHeader(handle: Handle<AdminPageHeaderProps>) {
	return () => {
		const currentPath = new URL(handle.props.currentHref, 'http://localhost')
			.pathname

		return (
			<>
				<AccountManagementHeader
					title={handle.props.title}
					description={handle.props.description}
				/>
				<AccountManagementLinkNav
					label="Admin sections"
					items={adminNavItems.map((item) => ({
						href: item.href,
						label: item.label,
						// Prefix-aware like account nav so `/admin/users/42`
						// keeps Users highlighted. `/admin` stays exact-only
						// so sibling pages (`/admin/invites`, …) are unaffected.
						active: item.paths.some(
							(path) =>
								path === currentPath ||
								(path !== '/admin' && currentPath.startsWith(`${path}/`)),
						),
					}))}
				/>
			</>
		)
	}
}

type AccountManagementMessageProps = {
	children: AccountManagementSlot
	tone?: 'info' | 'error'
}

export function AccountManagementMessage(
	handle: Handle<AccountManagementMessageProps>,
) {
	return () => (
		<p
			role={handle.props.tone === 'error' ? 'alert' : 'status'}
			aria-live={handle.props.tone === 'error' ? 'assertive' : 'polite'}
			mix={css({
				color: handle.props.tone === 'error' ? colors.error : colors.text,
				margin: 0,
			})}
		>
			{handle.props.children}
		</p>
	)
}

type AccountManagementLayoutProps = {
	sidebar: AccountManagementSlot
	children: AccountManagementSlot
	sidebarWidth?: string
	/**
	 * On narrow viewports the panes stack. `detail-first` puts the selected
	 * record above the list so phones are not stuck scrolling past filters.
	 */
	narrowOrder?: 'sidebar-first' | 'detail-first'
}

export function AccountManagementLayout(
	handle: Handle<AccountManagementLayoutProps>,
) {
	return () => (
		<section
			mix={css({
				display: 'grid',
				gridTemplateColumns: `${handle.props.sidebarWidth ?? 'minmax(18rem, 22rem)'} minmax(0, 1fr)`,
				gap: spacing.lg,
				alignItems: 'start',
				minWidth: 0,
				[accountManagementStackMq]: {
					gridTemplateColumns: 'minmax(0, 1fr)',
					...(handle.props.narrowOrder === 'detail-first'
						? {
								'& > :last-child': {
									order: -1,
								},
							}
						: {}),
				},
			})}
		>
			{handle.props.sidebar}
			<div mix={css({ display: 'grid', gap: spacing.lg, minWidth: 0 })}>
				{handle.props.children}
			</div>
		</section>
	)
}

type AccountManagementSidebarProps = {
	title: string
	description: string
	children: AccountManagementSlot
}

export function AccountManagementSidebar(
	handle: Handle<AccountManagementSidebarProps>,
) {
	return () => (
		<aside
			mix={css({
				...getSurfaceCardCss(),
				padding: spacing.lg,
				display: 'grid',
				gap: spacing.md,
				alignSelf: 'start',
				// Grid items default to min-width:auto; without this, long
				// search placeholders / unbreakable tokens expand past the
				// sidebar track and paint over the detail pane.
				minWidth: 0,
				maxWidth: '100%',
				overflow: 'hidden',
			})}
		>
			<div mix={css({ display: 'grid', gap: '0.6rem', minWidth: 0 })}>
				<h2 mix={css(accountSectionTitleCss)}>{handle.props.title}</h2>
				<p
					mix={css({
						...accountSectionLedeCss,
						overflowWrap: 'anywhere',
					})}
				>
					{handle.props.description}
				</p>
			</div>
			{handle.props.children}
		</aside>
	)
}

/**
 * Default in-sidebar scroll viewport for management lists. Keeps long result
 * sets from stretching the whole page; callers can override per page.
 */
export const accountManagementListMaxHeight = 'min(65vh, 48rem)'

type AccountManagementListProps = {
	children: AccountManagementSlot
	/**
	 * Scroll viewport height. Defaults to {@link accountManagementListMaxHeight}.
	 * Pass `null` only for the rare list that should grow with the page.
	 */
	maxHeight?: string | null
}

export function AccountManagementList(
	handle: Handle<AccountManagementListProps>,
) {
	return () => {
		const maxHeight =
			handle.props.maxHeight === undefined
				? accountManagementListMaxHeight
				: handle.props.maxHeight
		const scrollable = maxHeight != null

		return (
			<div
				mix={css({
					minWidth: 0,
					maxHeight: scrollable ? maxHeight : undefined,
					overflowY: scrollable ? 'auto' : undefined,
					overflowX: scrollable ? 'hidden' : undefined,
					paddingRight: scrollable ? spacing.xs : undefined,
				})}
			>
				<ul
					mix={css({
						listStyle: 'none',
						padding: 0,
						margin: 0,
						display: 'grid',
						gap: spacing.sm,
						minWidth: 0,
					})}
				>
					{handle.props.children}
				</ul>
			</div>
		)
	}
}

type AccountManagementSearchFieldProps = {
	label: string
	placeholder: string
	value: string
	onInput: (value: string) => void
}

/**
 * URL-backed search input for sidebar lists (secrets, admin users, ...).
 * Callers own the URL update — typically `replaceLocation(...)` with the
 * value written to a `q` query param.
 */
export function AccountManagementSearchField(
	handle: Handle<AccountManagementSearchFieldProps>,
) {
	return () => (
		<label mix={css(accountFieldCss)}>
			<span mix={css(accountFieldLabelCss)}>{handle.props.label}</span>
			<input
				type="search"
				data-field-ring
				value={handle.props.value}
				placeholder={handle.props.placeholder}
				aria-label={handle.props.label}
				mix={[
					on('input', (event) =>
						handle.props.onInput(
							(event.currentTarget as HTMLInputElement).value,
						),
					),
					css({
						...accountInputCss,
						paddingRight: spacing.xl,
					}),
				]}
			/>
		</label>
	)
}

type AccountManagementListItemLinkProps = {
	href: string
	active: boolean
	disabled?: boolean
	/**
	 * Pre-navigation state resets (clear messages, collapse delete
	 * confirmations). Runs only for clicks the router intercepts as an SPA
	 * navigation, so open-in-new-tab clicks leave the current pane untouched.
	 */
	onNavigate?: () => void
	children: AccountManagementSlot
}

/**
 * List/detail sidebar entry rendered as a real link: middle/cmd-click opens
 * the record in a new tab, hover warms the destination loader, and
 * `data-prevent-scroll-reset` keeps the page's scroll position when the
 * detail pane swaps in. While `disabled`, the `href` is dropped so the router
 * ignores clicks mid-mutation.
 */
export function AccountManagementListItemLink(
	handle: Handle<AccountManagementListItemLinkProps>,
) {
	return () => (
		<a
			href={handle.props.disabled ? undefined : handle.props.href}
			data-prevent-scroll-reset
			aria-current={handle.props.active ? 'true' : undefined}
			aria-disabled={handle.props.disabled ? 'true' : undefined}
			mix={[
				on('click', (event: MouseEvent) => {
					if (handle.props.disabled || !handle.props.onNavigate) return
					if (
						!(event.currentTarget instanceof HTMLAnchorElement) ||
						!shouldRouterHandleClick(event, event.currentTarget)
					) {
						return
					}
					handle.props.onNavigate()
				}),
				css({
					width: '100%',
					minWidth: 0,
					maxWidth: '100%',
					textAlign: 'left',
					textDecoration: 'none',
					display: 'grid',
					gap: spacing.xs,
					padding: spacing.md,
					overflow: 'hidden',
					overflowWrap: 'anywhere',
					borderRadius: radius.md,
					border: `1px solid ${
						handle.props.active ? colors.primary : colors.border
					}`,
					borderLeftWidth: handle.props.active ? '0.3rem' : '1px',
					backgroundColor: handle.props.active
						? colors.primarySoftest
						: colors.background,
					color: colors.text,
					cursor: handle.props.disabled ? 'not-allowed' : 'pointer',
					opacity: handle.props.disabled ? 0.7 : 1,
				}),
			]}
		>
			{handle.props.children}
		</a>
	)
}

type AccountManagementPanelProps = {
	title?: string
	description?: string
	children?: AccountManagementSlot
	asForm?: boolean
	onSubmit?: (event: SubmitEvent) => void
	ariaLabel?: string
}

export function AccountManagementPanel(
	handle: Handle<AccountManagementPanelProps>,
) {
	const content = () => (
		<>
			{handle.props.title || handle.props.description ? (
				<div mix={css({ display: 'grid', gap: '0.6rem' })}>
					{handle.props.title ? (
						<h2 mix={css(accountSectionTitleCss)}>{handle.props.title}</h2>
					) : null}
					{handle.props.description ? (
						<p mix={css(accountSectionLedeCss)}>{handle.props.description}</p>
					) : null}
				</div>
			) : null}
			{handle.props.children}
		</>
	)

	return () =>
		handle.props.asForm ? (
			<form
				method="post"
				noValidate
				mix={[
					css(accountSectionCss),
					handle.props.onSubmit
						? on('submit', (event) => handle.props.onSubmit?.(event))
						: null,
				]}
			>
				{content()}
			</form>
		) : (
			<section aria-label={handle.props.ariaLabel} mix={css(accountSectionCss)}>
				{content()}
			</section>
		)
}

type MetadataGridProps = {
	items: Array<{
		label: string
		value: AccountManagementSlot
	}>
	columns?: 2 | 3
}

export function MetadataGrid(handle: Handle<MetadataGridProps>) {
	return () => (
		<dl
			mix={css({
				display: 'grid',
				gridTemplateColumns: `repeat(${handle.props.columns ?? 2}, minmax(0, 1fr))`,
				gap: spacing.md,
				margin: 0,
				[accountManagementNarrowMq]: {
					gridTemplateColumns: '1fr',
				},
			})}
		>
			{handle.props.items.map((item) => (
				<div key={item.label} mix={css({ minWidth: 0 })}>
					<dt mix={css(accountFieldLabelCss)}>{item.label}</dt>
					<dd
						mix={css({
							margin: 0,
							color: colors.text,
							minWidth: 0,
							overflowWrap: 'anywhere',
						})}
					>
						{item.value}
					</dd>
				</div>
			))}
		</dl>
	)
}

/**
 * Quiet surface callout, matching the prototype's `.onboard-callout` chrome.
 * The redesign never uses green as a background wash — emphasis lives in the
 * callout's copy and action, not its border.
 */
export const noticeCardCss = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

export const accountManagementTableCss = {
	width: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: typography.fontSize.sm,
}

export const accountManagementTableCellCss = {
	padding: `${spacing.sm} ${spacing.md}`,
	borderBottom: `1px solid ${colors.border}`,
	textAlign: 'left' as const,
	verticalAlign: 'top' as const,
}

export const accountManagementTableNumericCellCss = {
	...accountManagementTableCellCss,
	textAlign: 'right' as const,
	fontVariantNumeric: 'tabular-nums',
}
