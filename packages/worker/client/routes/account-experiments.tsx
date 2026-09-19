import { type Handle, css } from 'remix/ui'
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
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
} from '#client/routes/account-management-components.tsx'
import { type AccountExperimentsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const experimentsApiPath = routes.accountExperimentsApi.href()

export async function accountExperimentsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(experimentsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountExperimentsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load experiments preferences.')
	}
	return { accountExperiments: payload }
}

export function AccountExperimentsRoute(handle: Handle) {
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let saving = false
	let payload: AccountExperimentsLoaderData | null = null
	let appliedSnapshot: AccountExperimentsLoaderData | null = null

	const experimentsData = createRouteData({
		key: 'accountExperiments',
		async load(_href, signal) {
			const response = await fetch(experimentsApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (response.status === 401) return routeDataRedirect('/login')
			const next = await readJson<AccountExperimentsLoaderData>(response)
			if (!response.ok || !next?.ok) {
				throw new Error('Unable to load experiments preferences.')
			}
			return next
		},
	})

	async function saveOptIn(enabled: boolean) {
		if (saving) return
		saving = true
		message = null
		handle.update()
		try {
			const response = await fetch(routes.accountExperimentsApiPost.href(), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ experimentsOptIn: enabled }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const next = await readJson<AccountExperimentsLoaderData>(response)
			if (!response.ok || !next?.ok) {
				throw new Error(
					(next && 'error' in next && typeof next.error === 'string'
						? next.error
						: null) ?? 'Unable to update experiments preference.',
				)
			}
			// Keep `appliedSnapshot` on the route-data cache object so the next
			// render does not treat that still-cached value as a newer snapshot
			// and overwrite the POST result (same pattern as account-shared).
			payload = next
			message = enabled
				? 'You are opted into experiments. You can turn this off anytime.'
				: 'You are opted out of experiments.'
			messageTone = 'info'
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Unable to update experiments preference.'
			messageTone = 'error'
		} finally {
			saving = false
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = experimentsData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedSnapshot) {
			payload = snapshot.data
			appliedSnapshot = snapshot.data
		}
		const pending = snapshot.kind === 'pending'

		return (
			<AccountManagementShell busy={(pending && payload !== null) || saving}>
				<AccountPageHeader
					title="Experiments"
					description="Opt into early, unfinished work. Things may change or break; you can leave anytime."
					currentHref={currentHref}
				/>
				{pending && payload === null ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading experiments…
					</p>
				) : null}
				{snapshot.error ? (
					<AccountManagementMessage tone="error">
						{snapshot.error.message}
					</AccountManagementMessage>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{payload ? (
					<AccountManagementPanel
						title="Account experiments"
						description="When you opt in, feature flags that target the experiments audience can include you. This does not turn every experiment on by itself — operators still enable each flag."
					>
						<label
							mix={css({
								...accountFieldCss,
								display: 'grid',
								gridTemplateColumns: 'auto 1fr',
								gap: spacing.md,
								alignItems: 'start',
							})}
						>
							<input
								type="checkbox"
								checked={payload.experimentsOptIn}
								disabled={saving}
								mix={[
									css({
										width: '1.25rem',
										height: '1.25rem',
										marginTop: '0.2rem',
										accentColor: colors.primary,
									}),
									on('change', (event) => {
										if (!(event.currentTarget instanceof HTMLInputElement)) {
											return
										}
										void saveOptIn(event.currentTarget.checked)
									}),
								]}
							/>
							<span>
								<span
									mix={css({
										...accountFieldLabelCss,
										display: 'block',
										marginBottom: spacing.xs,
										fontSize: typography.fontSize.base,
									})}
								>
									Opt into experiments
								</span>
								<span mix={css(accountFieldNoteCss)}>
									Expect unfinished UI, changing behavior, and occasional rough
									edges. Opt out here whenever you want to leave the audience.
								</span>
							</span>
						</label>
						{payload.experimentsOptIn ? (
							<p
								mix={css({
									margin: 0,
									marginTop: spacing.lg,
									color: colors.textMuted,
									fontSize: typography.fontSize.sm,
									maxWidth: '60ch',
								})}
							>
								You are in the experiments audience. Individual flags still need
								to be enabled (globally, by percentage, or by override) before
								you see them.
							</p>
						) : (
							<p
								mix={css({
									margin: 0,
									marginTop: spacing.lg,
									color: colors.textMuted,
									fontSize: typography.fontSize.sm,
									maxWidth: '60ch',
								})}
							>
								No experiments are targeted at you while this is off. When
								something is ready for a wider dogfood, it can use this audience
								— you will only see it after you opt in and the flag is on for
								you.
							</p>
						)}
						{saving ? (
							<p
								mix={css({
									margin: 0,
									marginTop: spacing.md,
									color: colors.textMuted,
									fontSize: typography.fontSize.sm,
								})}
							>
								Saving…
							</p>
						) : null}
					</AccountManagementPanel>
				) : null}
			</AccountManagementShell>
		)
	}
}
