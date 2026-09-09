import { type Handle, css } from 'remix/ui'
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
import { type AccountWaitingLoaderData } from '#universal/loader-data.ts'
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
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(waitingApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
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
		async load(_href, signal) {
			const response = await fetch(waitingApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (response.status === 401) return routeDataRedirect('/login')
			const payload = await readJson<AccountWaitingLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load waiting items.')
			}
			return payload
		},
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
				{data ? renderWaitingBody(data.items) : null}
			</AccountManagementShell>
		)
	}
}

function renderWaitingBody(items: Array<WaitingItem>) {
	if (items.length === 0) {
		return (
			<AccountManagementPanel
				title="Nothing is waiting on you"
				description="Onboarding is done, connections are healthy, and no publishes or grants need a click."
			>
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					<a href={routes.accountActivity.href()}>Activity</a> is run history.{' '}
					<a href={routes.accountEmail.href()}>Email</a> is your mailbox.
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
					<h2
						mix={css({
							margin: 0,
							fontSize: '1.05rem',
							fontWeight: 700,
							letterSpacing: '-0.01em',
							lineHeight: 1.3,
						})}
					>
						{item.title}
					</h2>
					<p
						mix={css({
							margin: 0,
							color: colors.textMuted,
							fontSize: '0.95rem',
							lineHeight: 1.5,
						})}
					>
						{item.why}
					</p>
					<a
						href={item.href}
						mix={css({
							...getPillButtonCss({ size: 'sm' }),
							width: 'fit-content',
							textDecoration: 'none',
						})}
					>
						{item.doLabel}
					</a>
				</section>
			))}
		</div>
	)
}
