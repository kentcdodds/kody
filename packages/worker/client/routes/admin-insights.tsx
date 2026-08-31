import { css, type Handle } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors } from '#universal/styles/tokens.ts'
import { type AdminInsightsLoaderData } from '#universal/loader-data.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import {
	adminInsightsApiPath,
	isAdminInsightsPath,
} from './admin-insights-shared.ts'
import { renderDashboard } from './admin-insights-dashboard.tsx'

type PageStatus = 'loading' | 'ready' | 'error'

export function AdminInsightsRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let data: AdminInsightsLoaderData | null = null
	let message: string | null = null
	let loadRequestId = 0
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null

	function applyData(payload: AdminInsightsLoaderData, href: string) {
		data = payload
		status = 'ready'
		message = null
		lastLoadedHref = href
		lastFailedHref = null
	}

	async function loadAdminInsights() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(adminInsightsApiPath, {
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
				message = 'You do not have permission to view admin insights.'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminInsightsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load admin insights.')
			}
			applyData(payload, href)
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load admin insights.'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isAdminInsightsPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'adminInsights', href)
		if (!routeData) return false
		applyData(routeData, href)
		return true
	}

	let lastSeenHref = ''

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (currentHref !== lastSeenHref) {
			lastSeenHref = currentHref
			lastFailedHref = null
		}

		const appliedRouteData = applyRouteLoaderData(currentHref)
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
			handle.queueTask(loadAdminInsights)
		}

		return (
			<AccountManagementShell maxWidth="min(100%, 92rem)">
				<AdminPageHeader
					title="Admin insights"
					description="Platform-wide activity at a glance. Aggregated account metadata only — user content is never shown."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading insights…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}
				{data ? renderDashboard(data) : null}
			</AccountManagementShell>
		)
	}
}
