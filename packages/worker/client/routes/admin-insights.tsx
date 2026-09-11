import { css, type Handle } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors } from '#universal/styles/tokens.ts'
import { type AdminInsightsLoaderData } from '#universal/loader-data.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import { adminInsightsApiPath } from './admin-insights-shared.ts'
import { renderDashboard } from './admin-insights-dashboard.tsx'

type PageStatus = 'loading' | 'ready' | 'error'

export function AdminInsightsRoute(handle: Handle) {
	let data: AdminInsightsLoaderData | null = null
	let message: string | null = null
	/** Payload last applied to the closure state above. */
	let appliedPayload: AdminInsightsLoaderData | null = null
	let appliedError: Error | null = null
	const insightsData = createRouteData({
		key: 'adminInsights',
		async load(_href, signal) {
			const response = await fetch(adminInsightsApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (response.status === 401) return routeDataRedirect('/login')
			if (response.status === 403) {
				throw new Error('You do not have permission to view admin insights.')
			}
			const payload = await readJson<AdminInsightsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load admin insights.')
			}
			return payload
		},
	})

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = insightsData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			data = snapshot.data
			message = null
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			message = snapshot.error.message
		}
		const pending = snapshot.kind === 'pending'
		const status: PageStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'

		return (
			<AccountManagementShell
				maxWidth="min(100%, 92rem)"
				busy={pending && appliedPayload !== null}
			>
				<AdminPageHeader
					title="Admin insights"
					description="Launch signals, paid mix, cost vs pay, and platform activity. Aggregated account metadata only — user content is never shown."
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
