import { type Handle, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import { getSecondaryButtonCss } from '#client/styles/style-primitives.ts'
import {
	AccountManagementHeader,
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
} from './account-management-components.tsx'
import { type AdminRolesLoaderData } from '#app/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type AccountStatus = 'loading' | 'ready' | 'error'

const adminRolesApiPath = '/admin/roles.json'

function isAdminRolesPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/admin/roles'
}

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
	let status: AccountStatus = 'loading'
	let roles: AdminRolesLoaderData['roles'] = []
	let message: string | null = null
	let loadRequestId = 0
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null

	async function loadAdminRoles() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(adminRolesApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view admin roles.'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminRolesLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load admin roles.')
			}
			roles = payload.roles
			status = 'ready'
			message = null
			lastLoadedHref = readCurrentRouterHref(handle)
			lastFailedHref = null
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load admin roles.'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isAdminRolesPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'adminRoles', href)
		if (!routeData) return false
		roles = routeData.roles
		status = 'ready'
		message = null
		lastLoadedHref = href
		lastFailedHref = null
		return true
	}

	const secondaryButtonCss = getSecondaryButtonCss()

	let lastSeenHref = ''

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		// The failure latch only guards retry loops for the location that
		// failed; leaving it (or coming back) must allow a fresh attempt.
		if (currentHref !== lastSeenHref) {
			lastSeenHref = currentHref
			lastFailedHref = null
		}

		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// href change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad =
			(status === 'loading' ||
				currentHref !== lastLoadedHref ||
				needsStaleRefresh) &&
			currentHref !== lastFailedHref &&
			loadingForHref !== currentHref
		if (!appliedRouteData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingForHref = currentHref
			handle.queueTask(loadAdminRoles)
		}

		return (
			<AccountManagementShell>
				<AccountManagementHeader
					title="Admin roles"
					description="Read-only view of roles and the permissions attached to each."
					actions={
						<>
							<a
								href="/admin/users"
								mix={css({ ...secondaryButtonCss, textDecoration: 'none' })}
							>
								View users
							</a>
							<a
								href="/admin/community-reports"
								mix={css({ ...secondaryButtonCss, textDecoration: 'none' })}
							>
								Community reports
							</a>
						</>
					}
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
