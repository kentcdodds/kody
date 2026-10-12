import { type Handle, css } from 'remix/component'
import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
	accountDisclosureCss,
} from './account-management-components.tsx'
import { type AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'
import {
	getAccentCalloutCss,
	getGhostButtonCss,
	getPrimaryButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

const approveCapabilitiesMatcher = createMatcher(
	routes.communityPackageApproveCapabilities.pattern,
)

type PageStatus = 'loading' | 'ready' | 'error' | 'approving'

const loadFailureMessage = 'Unable to load this capability approval.'

function isApproveCapabilitiesPath(href: string) {
	return (
		approveCapabilitiesMatcher.match(new URL(href, 'http://localhost')) !== null
	)
}

function buildApproveCapabilitiesApiUrl(href: string) {
	const url = new URL(href, 'http://localhost')
	const match = approveCapabilitiesMatcher.match(url)
	return routes.communityPackageApproveCapabilitiesApi.href({
		username: match?.params.username ?? '',
		kodyId: match?.params.kodyId ?? '',
	})
}

export async function accountPackageApproveCapabilitiesRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildApproveCapabilitiesApiUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload =
		await readJson<AccountPackageApproveCapabilitiesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load this capability approval.')
	}
	return { accountPackageApproveCapabilities: payload }
}

export function AccountPackageApproveCapabilitiesRoute(handle: Handle) {
	let payload: AccountPackageApproveCapabilitiesLoaderData | null = null
	let approving = false
	let message: string | null = null
	let appliedError: Error | null = null
	const approveCapabilitiesData = createRouteData({
		key: 'accountPackageApproveCapabilities',
		async load(href, signal) {
			const response = await fetch(buildApproveCapabilitiesApiUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			}).catch(() => null)
			if (!response) throw new Error(loadFailureMessage)
			if (response.status === 401) return routeDataRedirect('/login')
			const next =
				await readJson<AccountPackageApproveCapabilitiesLoaderData>(response)
			if (!response.ok || !next?.ok) throw new Error(loadFailureMessage)
			return next
		},
	})

	async function approveCapabilities() {
		if (!payload?.publishedCommit || approving) return
		approving = true
		message = null
		handle.update()
		try {
			const response = await fetch(
				buildApproveCapabilitiesApiUrl(readCurrentRouterHref(handle)),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({
						action: 'approve-capabilities',
						packageId: payload.package.id,
					}),
				},
			)
			const body = await readJson<{ ok?: boolean; error?: string }>(response)
			if (!response.ok || body?.ok === false) {
				approving = false
				message = body?.error ?? 'Could not approve capabilities.'
				handle.update()
				return
			}
			window.location.assign(payload.settingsHref)
		} catch {
			approving = false
			message = 'Could not approve capabilities.'
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (!isApproveCapabilitiesPath(currentHref)) {
			return <AccountManagementShell>{null}</AccountManagementShell>
		}

		const snapshot = approveCapabilitiesData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== payload) {
			payload = snapshot.data
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
				: pending && payload === null
					? 'loading'
					: approving
						? 'approving'
						: 'ready'

		const credentialEntries =
			payload?.entries.filter((entry) => entry.kind === 'credential') ?? []
		const storageEntries =
			payload?.entries.filter((entry) => entry.kind === 'storage') ?? []

		return (
			<AccountManagementShell busy={pending && payload !== null}>
				<AccountPageHeader
					title="Approve internet-visible capabilities"
					description="Review every credential and capability this package can reach before serving it on the public internet. Secret values never appear here."
					currentHref={currentHref}
				/>
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}
				{status === 'loading' ? (
					<p mix={css({ margin: 0, color: colors.textMuted })}>Loading…</p>
				) : null}
				{status === 'error' ? (
					<p mix={css({ margin: 0, color: colors.textMuted })}>
						This capability approval could not be loaded.
					</p>
				) : null}
				{payload && (status === 'ready' || status === 'approving') ? (
					<section
						data-testid="package-approve-capabilities-card"
						mix={css({ display: 'grid', gap: spacing.lg })}
					>
						<MetadataGrid
							items={[
								{
									label: 'Package',
									value: payload.package.name,
								},
								{
									label: 'Slug',
									value: (
										<IdValue
											value={payload.package.kodyId}
											label="package slug"
										/>
									),
								},
								{
									label: 'Published commit',
									value: payload.publishedCommit ? (
										<IdValue
											value={payload.publishedCommit}
											label="published commit"
										/>
									) : (
										'Not published'
									),
								},
								{
									label: 'Fingerprint',
									value: (
										<IdValue value={payload.fingerprint} label="fingerprint" />
									),
								},
							]}
						/>
						{!payload.publishedCommit ? (
							<div mix={css(getAccentCalloutCss())}>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Publish this package before approving internet-visible
									capabilities.
								</p>
							</div>
						) : null}
						{payload.fingerprintMatchesApproval ? (
							<div mix={css(getAccentCalloutCss())}>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									This capability set is already approved
									{payload.latestApprovedAt
										? ` (${payload.latestApprovedAt})`
										: ''}
									. Approving again keeps internet-visible on for the same set.
								</p>
							</div>
						) : null}
						<section mix={css({ display: 'grid', gap: spacing.md })}>
							<h2
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
								})}
							>
								Credentials
							</h2>
							{credentialEntries.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									No user credentials are reachable from this package's current
									tree.
								</p>
							) : (
								<ul
									mix={css({
										margin: 0,
										padding: 0,
										listStyle: 'none',
										display: 'grid',
										gap: spacing.sm,
									})}
								>
									{credentialEntries.map((entry) => (
										<li
											key={entry.credentialId ?? entry.name}
											mix={css(capabilityRowCss)}
										>
											<div mix={css({ display: 'grid', gap: spacing.xs })}>
												<strong mix={css({ color: colors.text })}>
													{entry.name ?? entry.credentialId}
												</strong>
												<span mix={css({ color: colors.textMuted })}>
													{entry.credentialKind ?? 'secret'} · id{' '}
													<code>{entry.credentialId}</code>
												</span>
												<span mix={css({ color: colors.textMuted })}>
													Hosts:{' '}
													{entry.hosts.length > 0
														? entry.hosts.join(', ')
														: 'none approved'}
												</span>
												<details mix={css(accountDisclosureCss)}>
													<summary>How it is reached</summary>
													<p mix={css({ margin: 0, color: colors.textMuted })}>
														{entry.via.join(' → ')}
													</p>
												</details>
											</div>
										</li>
									))}
								</ul>
							)}
						</section>
						<section mix={css({ display: 'grid', gap: spacing.md })}>
							<h2
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
								})}
							>
								Other capabilities
							</h2>
							{storageEntries.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									No additional storage capabilities.
								</p>
							) : (
								<ul
									mix={css({
										margin: 0,
										padding: 0,
										listStyle: 'none',
										display: 'grid',
										gap: spacing.sm,
									})}
								>
									{storageEntries.map((entry) => (
										<li key={entry.storageId} mix={css(capabilityRowCss)}>
											<strong mix={css({ color: colors.text })}>
												Package storage
											</strong>
											<span mix={css({ color: colors.textMuted })}>
												<code>{entry.storageId}</code>
												{entry.via.length > 0
													? ` via ${entry.via.join(' → ')}`
													: ''}
											</span>
										</li>
									))}
								</ul>
							)}
						</section>
						<div
							mix={css({
								display: 'flex',
								flexWrap: 'wrap',
								gap: spacing.sm,
								alignItems: 'center',
							})}
						>
							<button
								type="button"
								disabled={status === 'approving' || !payload.publishedCommit}
								data-testid="package-approve-capabilities"
								mix={[
									css(getPrimaryButtonCss()),
									on('click', () => void approveCapabilities()),
								]}
							>
								{status === 'approving'
									? 'Approving…'
									: payload.package.isInternetVisible
										? 'Re-approve capability set'
										: 'Approve and make internet-visible'}
							</button>
							<a
								href={payload.settingsHref}
								mix={css(getGhostButtonCss())}
								data-testid="package-approve-capabilities-back"
							>
								Back to settings
							</a>
						</div>
					</section>
				) : null}
			</AccountManagementShell>
		)
	}
}

const capabilityRowCss = {
	display: 'grid',
	gap: spacing.xs,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
}
