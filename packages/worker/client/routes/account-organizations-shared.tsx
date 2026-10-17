import { type Handle, type RemixNode, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { renderIcon } from '#universal/icon.tsx'
import {
	type AccountOrganizationsLoaderData,
	type AccountRestorableOrganization,
} from '#universal/loader-data.ts'
import {
	orderOrganizations,
	orgIdentity,
	orgRoleLabel,
	orgOverviewPath,
	organizationsWithSignupFallback,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	hoverMq,
	mergeCss,
} from '#universal/styles/style-primitives.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	accountInputCss,
	noticeCardCss,
} from './account-management-components.tsx'
import {
	type PendingInviteActions,
	renderPendingInviteActions,
} from './pending-invite-actions.tsx'

export type OrgViewer = { displayName: string; avatarUrl: string | null }

/**
 * One organization as a row: avatar, name, handle, and trailing pills. A row
 * with an `href` is a link card; without one it is a plain listing (invites
 * point at organizations the person cannot open yet).
 */
export function renderOrgRow(input: {
	key: string
	slug: string
	displayName: string | null
	personal: boolean
	viewer: OrgViewer
	detail: string | null
	pills: Array<{ label: string; tone: 'accent' | 'quiet' }>
	href?: string
	testId: string
	trailing?: RemixNode
}) {
	const identity = orgIdentity(input, input.viewer)
	const detail = [identity.hasName ? identity.handle : null, input.detail]
		.filter(Boolean)
		.join(' · ')
	const body = (
		<>
			<UserAvatar
				displayName={identity.avatarName}
				avatarUrl={identity.avatarUrl}
				size={44}
				variant="well"
			/>
			<span mix={css(orgRowTextCss)}>
				<span mix={css(orgRowNameCss)}>{identity.name}</span>
				{detail ? <span mix={css(orgRowDetailCss)}>{detail}</span> : null}
			</span>
			{input.pills.length > 0 ? (
				<span mix={css(orgRowPillsCss)}>
					{input.pills.map((pill) => (
						<span
							key={pill.label}
							mix={css(pill.tone === 'accent' ? accentPillCss : quietPillCss)}
						>
							{pill.label}
						</span>
					))}
				</span>
			) : null}
			{input.trailing ?? null}
		</>
	)
	return (
		<li key={input.key} data-testid={input.testId} mix={css(orgRowItemCss)}>
			{input.href ? (
				<a href={input.href} mix={css(mergeCss(orgRowCss, orgRowLinkCss))}>
					{body}
					<span aria-hidden="true" mix={css(orgRowChevronCss)}>
						{renderIcon('chevron-right', { size: '1.1rem' })}
					</span>
				</a>
			) : (
				<div mix={css(orgRowCss)}>{body}</div>
			)}
		</li>
	)
}

export async function postRestoreOrganization(orgSlug: string) {
	const response = await fetch(
		routes.accountOrganizationsRestorePost.href({ orgSlug }),
		{
			method: 'POST',
			headers: { Accept: 'application/json' },
			credentials: 'include',
		},
	)
	const payload = await readJson<{
		ok?: boolean
		error?: string
		redirectTo?: string
	}>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error(payload?.error || 'Unable to restore that organization.')
	}
	return payload
}

export function renderOrganizationList(data: AccountOrganizationsLoaderData) {
	const organizations = orderOrganizations(
		organizationsWithSignupFallback({
			organizations: data.organizations,
			username: data.username,
		}),
	)
	return (
		<ul mix={css(orgListCss)} data-testid="account-organizations">
			{organizations.map((org) =>
				renderOrgRow({
					key: org.slug,
					slug: org.slug,
					displayName: org.displayName,
					personal: org.personal,
					viewer: data.viewer,
					detail: orgRoleLabel(org.role),
					pills: [],
					// Each org opens its overview: a team org's home (which
					// links Settings, Members, and its sections), the signup
					// org's workspace overview.
					href: org.personal
						? orgOverviewPath(org.slug)
						: routes.profile.href({ username: org.slug }),
					testId: 'account-organization',
				}),
			)}
		</ul>
	)
}

export function createRestorableActions(
	handle: Handle,
	options: { reload: () => void },
) {
	let busySlug: string | null = null
	let message: string | null = null
	let tone: 'info' | 'error' = 'info'

	async function restore(org: AccountRestorableOrganization) {
		if (busySlug) return
		busySlug = org.slug
		message = null
		handle.update()
		try {
			const payload = await postRestoreOrganization(org.slug)
			if (payload.redirectTo) {
				window.location.assign(payload.redirectTo)
				return
			}
			message = `Restored @${org.slug}.`
			tone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to restore that organization.'
			tone = 'error'
		}
		busySlug = null
		options.reload()
		handle.update()
	}

	return {
		get busySlug() {
			return busySlug
		},
		get message() {
			return message
		},
		get tone() {
			return tone
		},
		restore: (org: AccountRestorableOrganization) => void restore(org),
	}
}

type RestorableActions = ReturnType<typeof createRestorableActions>

export function renderRestorableOrganizations(
	data: AccountOrganizationsLoaderData,
	actions: RestorableActions,
) {
	if (data.restorableOrganizations.length === 0) return null
	return (
		<AccountManagementPanel
			title="Recently deleted"
			description="Organizations you owned that can be restored for 30 days after deletion. Handles stay reserved until the window ends."
			ariaLabel="Recently deleted organizations"
		>
			{actions.message ? (
				<AccountManagementMessage tone={actions.tone}>
					{actions.message}
				</AccountManagementMessage>
			) : null}
			<ul mix={css(orgListCss)} data-testid="restorable-organizations">
				{data.restorableOrganizations.map((org) =>
					renderOrgRow({
						key: org.slug,
						slug: org.slug,
						displayName: org.displayName,
						personal: false,
						viewer: data.viewer,
						detail: `Deleted ${formatTimestampDate(org.deletedAt)}`,
						pills: [{ label: 'Deleted', tone: 'quiet' }],
						testId: 'restorable-organization',
						trailing: (
							<button
								type="button"
								disabled={actions.busySlug === org.slug}
								data-testid="restore-organization"
								mix={[
									css(getPillButtonCss({ size: 'sm' })),
									on('click', () => actions.restore(org)),
								]}
							>
								{actions.busySlug === org.slug ? 'Restoring…' : 'Restore'}
							</button>
						),
					}),
				)}
			</ul>
		</AccountManagementPanel>
	)
}

export function renderInvites(
	data: AccountOrganizationsLoaderData,
	actions: PendingInviteActions,
) {
	if (data.pendingInvites.length === 0) {
		return (
			<div mix={css(emptyStateCss)} data-testid="invites-empty">
				<span aria-hidden="true" mix={css(emptyIconCss)}>
					{renderIcon('inbox', { size: '1.5rem' })}
				</span>
				<div mix={css({ display: 'grid', gap: spacing.xs })}>
					<p mix={css(emptyTitleCss)}>No invites waiting</p>
					<p mix={css(mutedCopyCss)}>
						When someone invites you to an organization, team, or package, it
						shows up here.
					</p>
				</div>
			</div>
		)
	}
	return (
		<ul mix={css(orgListCss)} data-testid="invites-list">
			{data.pendingInvites.map((invite) =>
				renderOrgRow({
					key: `${invite.source}:${invite.id}`,
					slug: invite.orgSlug,
					displayName: invite.orgDisplayName,
					personal: invite.orgPersonal,
					viewer: { displayName: '', avatarUrl: null },
					detail: `${invite.label} · Expires ${formatTimestampDate(invite.expiresAt)}`,
					pills: [],
					testId: 'pending-invite',
					trailing: renderPendingInviteActions(invite, actions),
				}),
			)}
		</ul>
	)
}

export const orgListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const orgRowItemCss = {
	minWidth: 0,
}

const orgRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.text,
	textDecoration: 'none',
}

const orgRowLinkCss = {
	transition: `border-color ${transitions.fast}, transform ${transitions.fast}`,
	'&:active': { transform: 'scale(0.995)' },
	[hoverMq]: {
		'&:hover': { borderColor: colors.textMuted, color: colors.text },
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&:active': { transform: 'none' },
	},
}

const orgRowTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
}

const orgRowNameCss = {
	fontWeight: 650,
	fontSize: '1rem',
	lineHeight: 1.25,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const orgRowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	lineHeight: 1.3,
	overflowWrap: 'anywhere' as const,
}

const orgRowPillsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'flex-end',
	gap: spacing.xs,
	flexShrink: 0,
}

const pillBaseCss = {
	display: 'inline-flex',
	alignItems: 'center',
	fontSize: '0.8rem',
	fontWeight: 600,
	lineHeight: 1.4,
	borderRadius: radius.full,
	padding: '0.1rem 0.6rem',
	whiteSpace: 'nowrap' as const,
}

const accentPillCss = {
	...pillBaseCss,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
}

const quietPillCss = {
	...pillBaseCss,
	color: colors.textMuted,
	boxShadow: `inset 0 0 0 1px ${colors.border}`,
}

const orgRowChevronCss = {
	display: 'inline-flex',
	flexShrink: 0,
	color: colors.textMuted,
}

export const formCss = {
	display: 'grid',
	gap: spacing.lg,
}

export const slugFieldCss = {
	display: 'flex',
	alignItems: 'stretch',
	minWidth: 0,
}

export const slugPrefixCss = {
	display: 'inline-flex',
	alignItems: 'center',
	paddingInline: '0.85rem',
	borderRadius: '12px 0 0 12px',
	border: `1.5px solid ${colors.fieldBorder}`,
	borderRight: 'none',
	backgroundColor: colors.background,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'nowrap' as const,
}

export const slugInputCss = {
	...accountInputCss,
	flex: '1 1 auto',
	minWidth: 0,
	borderTopLeftRadius: 0,
	borderBottomLeftRadius: 0,
}

export const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
}

const emptyStateCss = {
	...noticeCardCss,
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
}

const emptyIconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flexShrink: 0,
	width: '3rem',
	height: '3rem',
	borderRadius: radius.full,
	border: `1px dashed ${colors.border}`,
	color: colors.textMuted,
}

const emptyTitleCss = {
	margin: 0,
	fontWeight: 650,
	color: colors.text,
}
