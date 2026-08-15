import { css, type Handle } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAuthInputCss,
	hoverMq,
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

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
					// …and keep that reserved height out of the rows. `align-content`
					// defaults to `stretch`, which hands the leftover space to the
					// auto-sized tracks, so a page shorter than the floor grew a gap
					// between every section instead of ending early.
					alignContent: 'start',
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
		href: '/admin/platform-integrations',
		label: 'Platform integrations',
		paths: ['/admin/platform-integrations'],
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
				// Named so a view transition lifts it out of `<main>` / `page`
				// and the rail stays still even if a transition still runs.
				position: 'absolute',
				left: pageGutter,
				top: 0,
				bottom: 0,
				width: '200px',
				viewTransitionName: 'account-nav',
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
}

export function MetadataGrid(handle: Handle<MetadataGridProps>) {
	return () => (
		<dl
			mix={css({
				display: 'grid',
				// Columns come from the room available rather than a per-page
				// count. A declared `columns={3}` divided the 376px detail pane
				// into 115px columns, which is a third of a UUID. The 14rem floor
				// is what an id needs at the `IdValue` size; below two of those
				// the band is a single column on its own, at every viewport,
				// without a breakpoint having to guess the container's width.
				// The `min()` keeps the floor from overflowing a container
				// narrower than the floor itself.
				gridTemplateColumns: 'repeat(auto-fit, minmax(min(14rem, 100%), 1fr))',
				gap: spacing.md,
				margin: 0,
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
 * An identifier is a copy target, not a sentence. The value stays on one line
 * and clips, so a 36-character UUID can no longer break a metadata column into
 * five lines of hex.
 *
 * The whole string stays in the DOM — clipping is CSS, never a truncated
 * substring — so a screen reader still reads the id in full, and `user-select:
 * all` turns one click into a whole-value selection for anyone the clipboard
 * button does not work for. `title` is the mouse-hover convenience on top of
 * that, not the mechanism.
 */
export function IdValue(
	handle: Handle<{
		value: string
		/** Field name, so the copy button says which id it takes. */
		label: string
	}>,
) {
	return () => (
		<span
			mix={css({
				display: 'flex',
				alignItems: 'center',
				gap: '0.35rem',
				minWidth: 0,
			})}
		>
			<code
				title={handle.props.value}
				mix={css({
					minWidth: 0,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
					userSelect: 'all',
					fontFamily: 'monospace',
					fontSize: typography.fontSize.sm,
					padding: '0.2rem 0.42rem',
					borderRadius: radius.sm,
					border: `1px solid ${colors.border}`,
					backgroundColor: colors.background,
					color: colors.text,
				})}
			>
				{handle.props.value}
			</code>
			<CopyTextButton
				value={handle.props.value}
				variant="chip"
				ariaLabel={`Copy ${handle.props.label}`}
			/>
		</span>
	)
}

/**
 * A timestamp in a metadata cell reads as one token: a locale string breaking
 * after its comma looks like two values, and tabular figures keep a column of
 * them from shifting sideways as the digits change.
 */
export function TimestampValue(
	handle: Handle<{ value: string | null; fallback?: string }>,
) {
	return () => (
		<span
			mix={css({
				whiteSpace: 'nowrap',
				fontVariantNumeric: 'tabular-nums',
			})}
		>
			{formatNullableTimestamp(
				handle.props.value,
				handle.props.fallback ?? '—',
			)}
		</span>
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
