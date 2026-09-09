import { type Handle, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import { type AdminRolesLoaderData } from '#universal/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type AccountStatus = 'loading' | 'ready' | 'error'

const adminRolesApiPath = '/admin/roles.json'

export async function adminRolesRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(adminRolesApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view admin roles.')
	}
	const payload = await readJson<AdminRolesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load admin roles.')
	}
	return { adminRoles: payload }
}

export function AdminRolesRoute(handle: Handle) {
	let roles: AdminRolesLoaderData['roles'] = []
	let message: string | null = null
	let appliedPayload: AdminRolesLoaderData | null = null
	let appliedError: Error | null = null
	const rolesData = createRouteData({
		key: 'adminRoles',
		async load(_href, signal) {
			const response = await fetch(adminRolesApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (response.status === 401) return routeDataRedirect('/login')
			if (response.status === 403) {
				throw new Error('You do not have permission to view admin roles.')
			}
			const payload = await readJson<AdminRolesLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load admin roles.')
			}
			return payload
		},
	})

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = rolesData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			roles = snapshot.data.roles
			message = null
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			message = snapshot.error.message
		}
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'

		return (
			<AccountManagementShell busy={pending && appliedPayload !== null}>
				<AdminPageHeader
					title="Admin roles"
					description="Read-only view of roles and the permissions attached to each."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading roles…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}
				<div mix={css({ display: 'grid', gap: spacing.lg })}>
					{roles.map((role) => (
						<AccountManagementPanel
							key={role.name}
							title={role.name}
							description={role.description || 'No description provided.'}
						>
							<ul
								mix={css({
									margin: 0,
									paddingLeft: spacing.lg,
									display: 'grid',
									gap: spacing.xs,
								})}
							>
								{role.permissions.map((permission) => (
									<li key={permission}>
										<code mix={css({ fontSize: typography.fontSize.sm })}>
											{permission}
										</code>
									</li>
								))}
							</ul>
						</AccountManagementPanel>
					))}
				</div>
			</AccountManagementShell>
		)
	}
}
