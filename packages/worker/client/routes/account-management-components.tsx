import { css, type Handle } from 'remix/ui'
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
	fieldLabelCss,
} from '#client/styles/style-primitives.ts'

type AccountManagementSlot = any

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
				maxWidth: handle.props.maxWidth ?? '96rem',
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
			<section mix={css(cardCss)}>{content()}</section>
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
