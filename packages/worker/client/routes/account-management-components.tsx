import { css, type Handle } from 'remix/ui'
import { routes } from '#app/routes.ts'
import { on } from '#client/event-mixin.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getSecondaryButtonCss,
	inputCss,
	layoutMaxWidths,
} from '#client/styles/style-primitives.ts'

type AccountManagementSlot = any

type AccountManagementLinkNavItem = {
	href: string
	label: string
	active: boolean
}

type AccountManagementShellProps = {
	maxWidth?: string
	children: AccountManagementSlot
}

export function AccountManagementShell(
	handle: Handle<AccountManagementShellProps>,
) {
	return () => (
		<section
			mix={css({
				maxWidth: handle.props.maxWidth ?? layoutMaxWidths.wide,
				margin: '0 auto',
				display: 'grid',
				gap: spacing.xl,
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
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h1
					mix={css({
						fontSize: typography.fontSize.xl,
						fontWeight: typography.fontWeight.semibold,
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

export function AccountManagementLinkNav(
	handle: Handle<AccountManagementLinkNavProps>,
) {
	const secondaryButtonCss = getSecondaryButtonCss()

	return () => (
		<nav
			aria-label={handle.props.label}
			mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}
		>
			{handle.props.items.map((item) => (
				<a
					key={item.href}
					href={item.href}
					aria-current={item.active ? 'page' : undefined}
					mix={css({
						...secondaryButtonCss,
						textDecoration: 'none',
						...(item.active
							? {
									borderColor: colors.primary,
									backgroundColor: colors.primarySoftest,
								}
							: {}),
					})}
				>
					{item.label}
				</a>
			))}
		</nav>
	)
}

const accountNavItems = [
	{ href: '/account', label: 'Overview' },
	{ href: '/account/billing', label: 'Billing' },
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
				[mq.mobile]: {
					gridTemplateColumns: '1fr',
				},
			})}
		>
			{handle.props.sidebar}
			<div mix={css({ display: 'grid', gap: spacing.lg })}>
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
				...cardCss,
				alignSelf: 'start',
			})}
		>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h2 mix={css(cardTitleCss)}>{handle.props.title}</h2>
				<p mix={css(descriptionCss)}>{handle.props.description}</p>
			</div>
			{handle.props.children}
		</aside>
	)
}

type AccountManagementListProps = {
	children: AccountManagementSlot
	maxHeight?: string
}

export function AccountManagementList(
	handle: Handle<AccountManagementListProps>,
) {
	return () => (
		<div
			mix={css({
				maxHeight: handle.props.maxHeight,
				overflowY: handle.props.maxHeight ? 'auto' : undefined,
				overflowX: handle.props.maxHeight ? 'hidden' : undefined,
				paddingRight: handle.props.maxHeight ? spacing.xs : undefined,
			})}
		>
			<ul
				mix={css({
					listStyle: 'none',
					padding: 0,
					margin: 0,
					display: 'grid',
					gap: spacing.sm,
				})}
			>
				{handle.props.children}
			</ul>
		</div>
	)
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
		<label mix={css(fieldCss)}>
			<span mix={css(fieldLabelCss)}>{handle.props.label}</span>
			<input
				type="search"
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
						...inputCss,
						paddingRight: spacing.xl,
					}),
				]}
			/>
		</label>
	)
}

type AccountManagementListItemButtonProps = {
	active: boolean
	disabled?: boolean
	onClick: () => void
	children: AccountManagementSlot
}

export function AccountManagementListItemButton(
	handle: Handle<AccountManagementListItemButtonProps>,
) {
	return () => (
		<button
			type="button"
			disabled={handle.props.disabled}
			mix={[
				on('click', handle.props.onClick),
				css({
					width: '100%',
					minWidth: 0,
					textAlign: 'left',
					display: 'grid',
					gap: spacing.xs,
					padding: spacing.md,
					overflow: 'hidden',
					borderRadius: radius.md,
					border: `1px solid ${
						handle.props.active ? colors.primary : colors.border
					}`,
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
		</button>
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
				<div mix={css({ display: 'grid', gap: spacing.xs })}>
					{handle.props.title ? (
						<h2 mix={css(cardTitleCss)}>{handle.props.title}</h2>
					) : null}
					{handle.props.description ? (
						<p mix={css(descriptionCss)}>{handle.props.description}</p>
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
					css(cardCss),
					handle.props.onSubmit
						? on('submit', (event) => handle.props.onSubmit?.(event))
						: null,
				]}
			>
				{content()}
			</form>
		) : (
			<section aria-label={handle.props.ariaLabel} mix={css(cardCss)}>
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
				[mq.mobile]: {
					gridTemplateColumns: '1fr',
				},
			})}
		>
			{handle.props.items.map((item) => (
				<div key={item.label}>
					<dt mix={css(fieldLabelCss)}>{item.label}</dt>
					<dd mix={css({ margin: 0, color: colors.text })}>{item.value}</dd>
				</div>
			))}
		</dl>
	)
}

export const noticeCardCss = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
	borderRadius: radius.lg,
	border: `1px solid ${colors.primary}`,
	backgroundColor: colors.primarySoftest,
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
