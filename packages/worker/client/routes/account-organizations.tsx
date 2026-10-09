import { type Handle, css } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { type AccountInvitesLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { getAuthInputCss } from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'

export async function accountOrganizationsNewRouteLoader(): Promise<RouteLoaderResult> {
	return {}
}

export function AccountOrganizationsNewRoute(handle: Handle) {
	const initialHref = readCurrentRouterHref(handle)
	const consumed = tryConsumeRouteLoaderData(
		handle,
		'accountOrganizations',
		initialHref,
	)
	const error = consumed?.ok ? consumed.error : null

	return () => {
		const href = readCurrentRouterHref(handle)
		const queryError = new URL(href, 'http://localhost').searchParams.get(
			'error',
		)
		const message = error || queryError
		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Create organization"
					description="An organization owns packages, secrets, and the rest of the work you do together."
					currentHref={href}
				/>
				{message ? (
					<p role="alert" mix={css({ color: colors.error, margin: 0 })}>
						{message}
					</p>
				) : null}
				<AccountManagementPanel
					title="New organization"
					description="The URL slug cannot be changed later."
				>
					<form method="post" action={routes.accountOrganizationsNew.href()}>
						<label mix={css({ display: 'grid', gap: '0.35rem' })}>
							Name
							<input
								name="displayName"
								required
								maxLength={80}
								mix={css(getAuthInputCss())}
							/>
						</label>
						<label
							mix={css({
								display: 'grid',
								gap: '0.35rem',
								marginTop: spacing.md,
							})}
						>
							URL slug
							<input
								name="slug"
								required
								autoCapitalize="none"
								spellCheck={false}
								mix={css(getAuthInputCss())}
							/>
						</label>
						<button type="submit" mix={css({ marginTop: spacing.md })}>
							Create organization
						</button>
					</form>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}

export async function accountInvitesRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(routes.accountInvitesApi.href(), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return routeLoaderRedirect('/login')
	const payload = await readJson<AccountInvitesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load invites.')
	}
	return { accountInvites: payload }
}

export function AccountInvitesRoute(handle: Handle) {
	const invitesData = createRouteData({
		key: 'accountInvites',
		async load(_href, signal) {
			const response = await fetch(routes.accountInvitesApi.href(), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (response.status === 401) return routeDataRedirect('/login')
			const payload = await readJson<AccountInvitesLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load invites.')
			}
			return payload
		},
	})

	return () => {
		const href = readCurrentRouterHref(handle)
		const snapshot = invitesData.read(handle, href)
		const invites = snapshot.data?.ok ? snapshot.data.invites : []
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && !snapshot.data
					? 'loading'
					: 'ready'
		return (
			<AccountManagementShell busy={pending && Boolean(snapshot.data)}>
				<AccountPageHeader
					title="Invites"
					description="Invites waiting for you. Accept one by pasting its prompt into an agent."
					currentHref={href}
				/>
				<AccountManagementPanel title="Pending invites">
					{status === 'loading' ? (
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							Loading invites…
						</p>
					) : null}
					{status === 'error' ? (
						<AccountManagementMessage tone="error">
							{snapshot.error?.message ?? 'Unable to load invites.'}
						</AccountManagementMessage>
					) : null}
					{status === 'ready' && invites.length === 0 ? (
						<p mix={css({ margin: 0, color: colors.textMuted })}>
							No invites waiting.
						</p>
					) : null}
					{status === 'ready' && invites.length > 0 ? (
						<ul mix={css({ margin: 0, paddingLeft: '1.1rem' })}>
							{invites.map((invite) => (
								<li key={invite.id}>
									@{invite.orgSlug}{' '}
									{invite.kind === 'membership' ? 'membership' : 'grant'}
									{invite.role ? ` (${invite.role})` : ''}
								</li>
							))}
						</ul>
					) : null}
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
