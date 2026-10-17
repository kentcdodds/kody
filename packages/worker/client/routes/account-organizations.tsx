import { type Handle, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { renderIcon } from '#universal/icon.tsx'
import { type AccountOrganizationsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	noticeCardCss,
} from './account-management-components.tsx'
import {
	createRestorableActions,
	mutedCopyCss,
	renderInvites,
	renderOrganizationList,
	renderRestorableOrganizations,
} from './account-organizations-shared.tsx'
import { createPendingInviteActions } from './pending-invite-actions.tsx'

export {
	AccountOrganizationsNewRoute,
	accountOrganizationsNewRouteLoader,
} from './account-organizations-create.tsx'

async function fetchOrganizations(signal: AbortSignal) {
	const response = await fetch(routes.accountOrganizationsApi.href(), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return 'unauthorized' as const
	const payload = await readJson<AccountOrganizationsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load organizations.')
	}
	return payload
}

export async function accountOrganizationsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const payload = await fetchOrganizations(signal)
	if (payload === 'unauthorized') return routeLoaderRedirect('/login')
	return { accountOrganizations: payload }
}

/**
 * Every organization the person belongs to, the one the header is acting in
 * marked Current, and the invites waiting on them.
 */
export function AccountOrganizationsRoute(handle: Handle) {
	const organizationsData = createRouteData({
		key: 'accountOrganizations',
		async load(_href, signal) {
			const payload = await fetchOrganizations(signal)
			if (payload === 'unauthorized') return routeDataRedirect('/login')
			return payload
		},
	})
	const reload = () =>
		organizationsData.reload(handle, readCurrentRouterHref(handle))
	const inviteActions = createPendingInviteActions(handle, { reload })
	const restorableActions = createRestorableActions(handle, { reload })

	return () => {
		const href = readCurrentRouterHref(handle)
		const snapshot = organizationsData.read(handle, href)
		const data = snapshot.data?.ok ? snapshot.data : null
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && !data
					? 'loading'
					: 'ready'
		return (
			<AccountManagementShell busy={pending && Boolean(data)}>
				<AccountPageHeader
					title="Organizations"
					description="Each organization has its own repositories, secrets, and members. Open one to work in it, or switch from your avatar menu. Deleted organizations you owned can be restored here for 30 days."
					currentHref={href}
					actions={
						<a
							href={routes.accountOrganizationsNew.href()}
							data-testid="account-organizations-create"
							mix={css(getPillButtonCss({ size: 'sm' }))}
						>
							{renderIcon('plus', { size: '1.05rem' })}
							Create organization
						</a>
					}
				/>
				{status === 'loading' ? (
					<p role="status" mix={css(mutedCopyCss)}>
						Loading organizations…
					</p>
				) : null}
				{status === 'error' ? (
					<div mix={css(noticeCardCss)} data-testid="organizations-error">
						<AccountManagementMessage tone="error">
							{snapshot.error?.message ?? 'Unable to load organizations.'}
						</AccountManagementMessage>
						<div>
							<button
								type="button"
								mix={[
									css(getGhostButtonCss({ size: 'sm' })),
									on('click', () => organizationsData.reload(handle, href)),
								]}
							>
								Try again
							</button>
						</div>
					</div>
				) : null}
				{status === 'ready' && data ? (
					<>
						<AccountManagementPanel
							title="Your organizations"
							ariaLabel="Your organizations"
						>
							{renderOrganizationList(data)}
						</AccountManagementPanel>
						{renderRestorableOrganizations(data, restorableActions)}
						<AccountManagementPanel
							id="invites"
							title="Invites"
							description="Invites addressed to you and invite links you opened. They also wait on your Waiting page."
							ariaLabel="Invites"
						>
							{inviteActions.message ? (
								<AccountManagementMessage tone={inviteActions.tone}>
									{inviteActions.message}
								</AccountManagementMessage>
							) : null}
							{renderInvites(data, inviteActions)}
						</AccountManagementPanel>
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}
