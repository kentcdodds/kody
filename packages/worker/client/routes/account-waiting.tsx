import { orgAccountApiFetchInit } from '#client/org-account-api.ts'
import { type Handle, css } from 'remix/component'
import { relocateAccountHref } from '#universal/org-pages.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	noticeCardCss,
} from '#client/routes/account-management-components.tsx'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import {
	createPendingInviteActions,
	type PendingInviteActions,
	renderPendingInviteActions,
} from '#client/routes/pending-invite-actions.tsx'
import {
	type AccountPendingInvite,
	type AccountWaitingLoaderData,
} from '#universal/loader-data.ts'
import { type WaitingItem, type WaitingSeverity } from '#universal/waiting.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

const waitingApiPath = routes.accountWaitingApi.href()

const severityAccent: Record<WaitingSeverity, string> = {
	block: colors.danger,
	degraded: colors.primary,
	setup: colors.border,
}

export async function accountWaitingRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(
		waitingApiPath,
		orgAccountApiFetchInit(url.href, signal),
	)
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountWaitingLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load waiting items.')
	}
	return { accountWaiting: payload }
}

export function AccountWaitingRoute(handle: Handle) {
	const waitingData = createRouteData({
		key: 'accountWaiting',
		async load(href, signal) {
			const response = await fetch(
				waitingApiPath,
				orgAccountApiFetchInit(href, signal),
			)
			if (response.status === 401) return routeDataRedirect('/login')
			const payload = await readJson<AccountWaitingLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load waiting items.')
			}
			return payload
		},
	})
	const inviteActions = createPendingInviteActions(handle, {
		reload: () => waitingData.reload(handle, readCurrentRouterHref(handle)),
	})

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = waitingData.read(handle, currentHref)
		const data = snapshot.data
		const pending = snapshot.kind === 'pending'

		return (
			<AccountManagementShell busy={pending && data !== null}>
				<AccountPageHeader
					title="Waiting"
					description="Things that need you."
					currentHref={currentHref}
				/>
				{pending && data === null ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading waiting items…
					</p>
				) : null}
				{snapshot.error ? (
					<AccountManagementMessage tone="error">
						{snapshot.error.message}
					</AccountManagementMessage>
				) : null}
				{inviteActions.message ? (
					<AccountManagementMessage tone={inviteActions.tone}>
						{inviteActions.message}
					</AccountManagementMessage>
				) : null}
				{data ? renderWaitingBody(data, currentHref, inviteActions) : null}
			</AccountManagementShell>
		)
	}
}

function inviteSender(invite: AccountPendingInvite) {
	return invite.orgDisplayName?.trim() || `@${invite.orgSlug}`
}

function renderInviteCard(
	invite: AccountPendingInvite,
	actions: PendingInviteActions,
) {
	return (
		<section
			key={`invite:${invite.source}:${invite.id}`}
			data-testid="waiting-invite"
			mix={css({
				...noticeCardCss,
				...getAccentCalloutCss({ accentColor: colors.primary }),
			})}
		>
			<h2 mix={css(cardTitleCss)}>{invite.label}</h2>
			<p mix={css(cardWhyCss)}>
				{`Invite from ${inviteSender(invite)} · Expires ${formatTimestampDate(invite.expiresAt)}`}
			</p>
			{renderPendingInviteActions(invite, actions)}
		</section>
	)
}

function renderWaitingBody(
	data: AccountWaitingLoaderData,
	currentHref: string,
	inviteActions: PendingInviteActions,
) {
	const items: Array<WaitingItem> = data.items
	if (items.length === 0 && data.invites.length === 0) {
		return (
			<AccountManagementPanel
				title="Nothing is waiting on you"
				description="Connections are healthy, no invites are waiting, and no publishes or grants need a click."
			>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					<a href={relocateAccountHref('/account/activity', currentHref)}>
						Activity
					</a>{' '}
					is run history.{' '}
					<a href={relocateAccountHref('/account/email', currentHref)}>Email</a>{' '}
					is your mailbox.
				</p>
			</AccountManagementPanel>
		)
	}

	return (
		<div
			mix={css({
				display: 'grid',
				gap: spacing.md,
			})}
		>
			{data.invites.map((invite) => renderInviteCard(invite, inviteActions))}
			{items.map((item) => (
				<section
					key={item.id}
					data-testid={`waiting-item-${item.kind}`}
					mix={css({
						...noticeCardCss,
						...getAccentCalloutCss({
							accentColor: severityAccent[item.severity],
						}),
					})}
				>
					<h2 mix={css(cardTitleCss)}>{item.title}</h2>
					<p mix={css(cardWhyCss)}>{item.why}</p>
					<a
						href={item.href}
						mix={[
							css({
								...getPillButtonCss({ size: 'sm' }),
								width: 'fit-content',
								textDecoration: 'none',
							}),
							on('click', () => {
								void fetch(routes.accountWaitingClickPost.href(), {
									method: 'POST',
									credentials: 'include',
									headers: { 'content-type': 'application/json' },
									body: JSON.stringify({ cardId: item.id }),
									keepalive: true,
								}).catch(() => {})
							}),
						]}
					>
						{item.doLabel}
					</a>
				</section>
			))}
		</div>
	)
}

const cardTitleCss = {
	margin: 0,
	fontSize: '1.05rem',
	fontWeight: 700,
	letterSpacing: '-0.01em',
	lineHeight: 1.3,
}

const cardWhyCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.95rem',
	lineHeight: 1.5,
}
