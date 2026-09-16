import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
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
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import { routes } from '#universal/routes.ts'
import { type AccountSecretProvidersLoaderData } from '#universal/loader-data.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getAccentCalloutCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	pageDescriptionCss,
} from '#universal/styles/style-primitives.ts'

const apiPath = routes.accountSecretProvidersApi.href()

function apiUrlForHref(href: string) {
	const url = new URL(href, 'http://localhost')
	const search = url.searchParams.toString()
	return search ? `${apiPath}?${search}` : apiPath
}

async function loadSecretProviders(
	href: string,
	signal: AbortSignal,
): Promise<AccountSecretProvidersLoaderData> {
	const response = await fetch(apiUrlForHref(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		throw new Error('Unauthorized.')
	}
	if (response.status === 404) {
		throw new Error('Not enabled.')
	}
	const payload = await readJson<AccountSecretProvidersLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load secret providers.')
	}
	return payload
}

export async function accountSecretProvidersRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(apiUrlForHref(url.pathname + url.search), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 404) {
		return routeLoaderRedirect(routes.accountSecrets.href())
	}
	const payload = await readJson<AccountSecretProvidersLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load secret providers.')
	}
	return { accountSecretProviders: payload }
}

export function AccountSecretProvidersRoute(handle: Handle) {
	const providersData = createRouteData({
		key: 'accountSecretProviders',
		async load(href, signal) {
			try {
				return await loadSecretProviders(href, signal)
			} catch (error) {
				if (error instanceof Error && error.message === 'Unauthorized.') {
					return routeDataRedirect('/login')
				}
				if (error instanceof Error && error.message === 'Not enabled.') {
					return routeDataRedirect(routes.accountSecrets.href())
				}
				throw error
			}
		},
	})
	let status: 'idle' | 'saving' | 'error' = 'idle'
	let message: string | null = null
	let bindProvider = '1password'
	let bindPackageId = ''
	let bindDoorSecret = ''
	let bindConfig = ''

	const submit = async (body: Record<string, unknown>, successHref: string) => {
		status = 'saving'
		message = null
		handle.update()
		const response = await fetch(apiPath, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(body),
		})
		if (response.status === 404) {
			status = 'error'
			message = 'External secret providers are not enabled for this account.'
			handle.update()
			return
		}
		const result = await readJson<{ ok?: boolean; error?: string }>(response)
		if (!response.ok || !result?.ok) {
			status = 'error'
			message = result?.error ?? 'Unable to update secret providers.'
			handle.update()
			return
		}
		status = 'idle'
		await navigate(successHref)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = providersData.read(handle, currentHref)
		const payload = snapshot.data
		const pending = snapshot.kind === 'pending'
		const disabled = status === 'saving' || pending
		if (!payload) {
			return (
				<AccountManagementShell busy={pending}>
					<AccountPageHeader
						title="Secret providers"
						description="Bind a saved package to a provider id such as 1password."
						currentHref={currentHref}
					/>
				</AccountManagementShell>
			)
		}
		const approval = payload.approval
		return (
			<AccountManagementShell busy={pending}>
				<AccountPageHeader
					title="Secret providers"
					description="Bind a saved package to a provider id such as 1password, and grant other packages use of canonical item refs. Values never appear here."
					currentHref={currentHref}
				/>
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}
				{approval ? (
					<section
						mix={css({
							...getAccentCalloutCss(),
							display: 'grid',
							gap: spacing.sm,
							padding: spacing.lg,
						})}
					>
						<h2
							mix={css({
								margin: 0,
								fontSize: typography.fontSize.lg,
								color: colors.text,
							})}
						>
							{approval.alreadyGranted
								? 'Package already granted'
								: 'Allow package access'}
						</h2>
						<p mix={css(pageDescriptionCss)}>
							Provider <strong>{approval.provider}</strong>, ref{' '}
							<code>{approval.canonicalRef}</code>, package{' '}
							<strong>{approval.kodyId}</strong>.
						</p>
						{approval.error ? (
							<p mix={css({ margin: 0, color: colors.error })}>
								{approval.error}
							</p>
						) : null}
						{approval.alreadyGranted || approval.error ? null : (
							<button
								type="button"
								disabled={disabled}
								mix={[
									css(getPrimaryButtonCss()),
									on('click', () => {
										void submit(
											{
												action: 'grant',
												provider: approval.provider,
												ref: approval.canonicalRef,
												packageId: approval.packageId,
											},
											routes.accountSecretProviders.href(),
										)
									}),
								]}
							>
								Allow
							</button>
						)}
					</section>
				) : null}
				<AccountManagementPanel title="Bindings">
					{payload.bindings.length === 0 ? (
						<p mix={css(pageDescriptionCss)}>No providers are bound yet.</p>
					) : (
						<ul
							mix={css({
								listStyle: 'none',
								margin: 0,
								padding: 0,
								display: 'grid',
								gap: spacing.md,
							})}
						>
							{payload.bindings.map((binding) => (
								<li
									key={binding.provider}
									mix={css({
										display: 'grid',
										gap: spacing.xs,
									})}
								>
									<strong mix={css({ color: colors.text })}>
										{binding.provider}
									</strong>
									<p mix={css(pageDescriptionCss)}>
										Package {binding.kodyId}. Door key {binding.doorSecretName}.
									</p>
									<button
										type="button"
										disabled={disabled}
										mix={[
											css(getSecondaryButtonCss()),
											on('click', () => {
												void submit(
													{
														action: 'unbind',
														provider: binding.provider,
													},
													routes.accountSecretProviders.href(),
												)
											}),
										]}
									>
										Unbind
									</button>
								</li>
							))}
						</ul>
					)}
				</AccountManagementPanel>
				<AccountManagementPanel title="Bind a provider">
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Provider id</span>
						<input
							mix={[
								css(accountInputCss),
								on('input', (event) => {
									bindProvider = event.currentTarget.value
									handle.update()
								}),
							]}
							value={bindProvider}
							disabled={disabled}
						/>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Package</span>
						<select
							mix={[
								css(accountInputCss),
								on('change', (event) => {
									bindPackageId = event.currentTarget.value
									handle.update()
								}),
							]}
							value={bindPackageId}
							disabled={disabled}
						>
							<option value="">Select a package</option>
							{payload.packages.map((savedPackage) => (
								<option value={savedPackage.id}>{savedPackage.kodyId}</option>
							))}
						</select>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Door-key secret</span>
						<select
							mix={[
								css(accountInputCss),
								on('change', (event) => {
									bindDoorSecret = event.currentTarget.value
									handle.update()
								}),
							]}
							value={bindDoorSecret}
							disabled={disabled}
						>
							<option value="">Select a user secret</option>
							{payload.doorSecrets.map((name) => (
								<option value={name}>{name}</option>
							))}
						</select>
					</label>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>
							Optional config JSON (non-secret, for example a Connect base URL)
						</span>
						<input
							mix={[
								css(accountInputCss),
								on('input', (event) => {
									bindConfig = event.currentTarget.value
									handle.update()
								}),
							]}
							value={bindConfig}
							disabled={disabled}
						/>
					</label>
					<button
						type="button"
						disabled={disabled}
						mix={[
							css(getPrimaryButtonCss()),
							on('click', () => {
								let config: Record<string, string> = {}
								if (bindConfig.trim()) {
									try {
										const parsed: unknown = JSON.parse(bindConfig)
										if (
											!parsed ||
											typeof parsed !== 'object' ||
											Array.isArray(parsed)
										) {
											throw new Error('Config must be a JSON object.')
										}
										for (const [key, value] of Object.entries(parsed)) {
											if (typeof value === 'string') config[key] = value
										}
									} catch (error) {
										status = 'error'
										message =
											error instanceof Error
												? error.message
												: 'Config must be a JSON object of strings.'
										handle.update()
										return
									}
								}
								void submit(
									{
										action: 'bind',
										provider: bindProvider,
										packageId: bindPackageId,
										doorSecretName: bindDoorSecret,
										config,
									},
									routes.accountSecretProviders.href(),
								)
							}),
						]}
					>
						Bind provider
					</button>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
}
