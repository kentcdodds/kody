import { normalizeSecretExpiresAt } from '@kody-internal/shared/secret-expires-at.ts'
import { type AccountSecretsLoaderData } from '#universal/loader-data.ts'
import { type Handle, css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import {
	type RouteLoaderResult,
	routeLoaderRedirect,
} from '#client/route-loader.ts'
import {
	accountSecretsApiPath,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	createEditorStateFromNewSecretQuery,
	type EditorState,
} from '#client/routes/account-secrets-shared.ts'
import { getNewSecretValueAutofocusKey } from '#client/routes/new-secret-query.ts'
import { normalizeAllowedHosts } from '#client/routes/secret-normalization.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { routes } from '#universal/routes.ts'

const pageCss = {
	...stackedPageCss,
	maxWidth: '32rem',
	margin: '0 auto',
}

const headerCss = {
	...pageHeaderCss,
	justifyItems: 'center',
	textAlign: 'center' as const,
}

const primaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

export async function connectSecretSetRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(accountSecretsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		const redirectTo = `${url.pathname}${url.search}`
		return routeLoaderRedirect(
			`/login?redirectTo=${encodeURIComponent(redirectTo)}`,
		)
	}
	const payload = (await response.json().catch(() => null)) as
		| (AccountSecretsLoaderData & { error?: string })
		| null
	if (!response.ok || !payload?.ok) {
		throw new Error(
			payload?.error || 'Unable to load this secret setup request.',
		)
	}
	return { accountSecrets: payload }
}

export function readConnectSecretSetView(input: {
	name: string
	saved: boolean
}) {
	const hasName = input.name.trim().length > 0
	return {
		hasName,
		saved: input.saved,
		showForm: hasName && !input.saved,
		showBackToSecrets: input.saved || !hasName,
	}
}

export function findMatchingSecretForSetup(
	secrets: AccountSecretsLoaderData['secrets'],
	state: Pick<EditorState, 'name' | 'scope' | 'packageId'>,
	options: { explicitPackageId?: string | null } = {},
) {
	const name = state.name.trim()
	if (!name) return null
	return (
		secrets.find((secret) => {
			if (secret.name !== name || secret.scope !== state.scope) return false
			if (state.scope !== 'package') return true
			// Require an explicit packageId from the setup URL. Do not match
			// against the editor fallback (first package option).
			const packageId = options.explicitPackageId?.trim()
			if (!packageId) return false
			return secret.packageId === packageId
		}) ?? null
	)
}

function queryHasNonEmptyList(params: URLSearchParams, keys: Array<string>) {
	return keys.some((key) =>
		params
			.getAll(key)
			.some((value) =>
				value.split(',').some((entry) => entry.trim().length > 0),
			),
	)
}

export function hydrateEditorStateForExistingSecret(
	state: EditorState,
	existing: NonNullable<ReturnType<typeof findMatchingSecretForSetup>>,
	href: string,
) {
	const params = new URL(href, 'http://localhost').searchParams
	const queryHasHosts = queryHasNonEmptyList(params, [
		'allowedHosts',
		'allowed-host',
	])
	const queryHasPackages = queryHasNonEmptyList(params, [
		'allowedPackages',
		'package_id',
		'package',
	])
	const queryHasDescription = Boolean(params.get('description')?.trim())
	// Only override expiry when the query parsed to a real value. An invalid
	// expiresAt must not clear an existing cutoff.
	const queryHasExpires = Boolean(state.expiresAt.trim())
	return {
		...state,
		currentId: existing.id,
		description: queryHasDescription ? state.description : existing.description,
		expiresAt: queryHasExpires ? state.expiresAt : (existing.expiresAt ?? ''),
		allowedHosts: queryHasHosts
			? state.allowedHosts
			: existing.allowedHosts.length > 0
				? existing.allowedHosts
				: [''],
		allowedPackages: queryHasPackages
			? state.allowedPackages
			: existing.allowedPackages,
	}
}

function readExplicitPackageId(href: string) {
	return (
		new URL(href, 'http://localhost').searchParams.get('packageId')?.trim() ||
		null
	)
}

export function readInvalidExpiresAtQuery(href: string) {
	const raw = new URL(href, 'http://localhost').searchParams
		.get('expiresAt')
		?.trim()
	if (!raw) return null
	try {
		const normalized = normalizeSecretExpiresAt(raw)
		if (!normalized) {
			return 'This setup link has an invalid expiresAt value.'
		}
		return null
	} catch {
		return 'This setup link has an invalid expiresAt value.'
	}
}

export function resolvePackageIdForSecretSet(input: {
	scope: EditorState['scope']
	explicitPackageId: string | null
	packageOptions: Array<{ id: string }>
}) {
	if (input.scope !== 'package') return { packageId: null as string | null }
	const packageId = input.explicitPackageId?.trim() || null
	if (!packageId) {
		return {
			packageId: null,
			error: 'Package-scoped setup links require a packageId.',
		}
	}
	if (!input.packageOptions.some((option) => option.id === packageId)) {
		return {
			packageId: null,
			error: 'This setup link names a package that is not available.',
		}
	}
	return { packageId }
}

function resolveSavePolicyFromSetup(input: {
	href: string
	state: EditorState
	existing: AccountSecretsLoaderData['secrets'][number] | null
}) {
	const params = new URL(input.href, 'http://localhost').searchParams
	const queryHasHosts = queryHasNonEmptyList(params, [
		'allowedHosts',
		'allowed-host',
	])
	const queryHasPackages = queryHasNonEmptyList(params, [
		'allowedPackages',
		'package_id',
		'package',
	])
	const queryHasExpires = Boolean(input.state.expiresAt.trim())
	const allowedHosts = queryHasHosts
		? normalizeAllowedHosts(
				input.state.allowedHosts.filter((host) => host.trim()),
			)
		: (input.existing?.allowedHosts ??
			normalizeAllowedHosts(
				input.state.allowedHosts.filter((host) => host.trim()),
			))
	const allowedPackages =
		input.state.scope === 'user'
			? queryHasPackages
				? [...input.state.allowedPackages].sort((left, right) =>
						left.localeCompare(right),
					)
				: [
						...(input.existing?.allowedPackages ?? input.state.allowedPackages),
					].sort((left, right) => left.localeCompare(right))
			: []
	const expiresAt = queryHasExpires
		? input.state.expiresAt || null
		: (input.existing?.expiresAt ?? (input.state.expiresAt || null))
	return { allowedHosts, allowedPackages, expiresAt }
}

export function ConnectSecretSetRoute(handle: Handle) {
	let data: AccountSecretsLoaderData | null = null
	let editorState: EditorState | null = null
	let appliedQueryKey = ''
	let saving = false
	let saved = false
	let savedForQueryKey = ''
	let message: string | null = null
	let showSecretValue = false
	let loadError: string | null = null

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function applyRouteLoaderData(href: string) {
		const routeData = tryConsumeRouteLoaderData(handle, 'accountSecrets', href)
		if (!routeData) return false
		data = routeData
		loadError = null
		return true
	}

	function setupQueryKey(href: string, packageOptions: Array<{ id: string }>) {
		return `${href}\0${packageOptions.map((item) => item.id).join(',')}`
	}

	function ensureEditorState(href: string) {
		const packageOptions = data?.packageOptions ?? []
		const queryKey = setupQueryKey(href, packageOptions)
		if (editorState && appliedQueryKey === queryKey) {
			// A concurrent save may refresh secrets without changing the query.
			// If we can now match an existing secret, re-hydrate policy once.
			if (!editorState.currentId) {
				const explicitPackageId = readExplicitPackageId(href)
				const existing = findMatchingSecretForSetup(
					data?.secrets ?? [],
					editorState,
					{ explicitPackageId },
				)
				if (existing) {
					editorState = hydrateEditorStateForExistingSecret(
						editorState,
						existing,
						href,
					)
				}
			}
			return editorState
		}
		if (appliedQueryKey !== queryKey) {
			saved = false
			savedForQueryKey = ''
			message = null
			saving = false
			showSecretValue = false
		}
		let next = createEditorStateFromNewSecretQuery(packageOptions, href)
		const explicitPackageId = readExplicitPackageId(href)
		const packageResolution = resolvePackageIdForSecretSet({
			scope: next.scope,
			explicitPackageId,
			packageOptions,
		})
		if (next.scope === 'package') {
			next = {
				...next,
				packageId: packageResolution.packageId ?? '',
			}
		}
		const existing = findMatchingSecretForSetup(data?.secrets ?? [], next, {
			explicitPackageId,
		})
		if (existing) {
			next = hydrateEditorStateForExistingSecret(next, existing, href)
		}
		editorState = next
		appliedQueryKey = queryKey
		return editorState
	}

	async function saveSecret(event: SubmitEvent) {
		event.preventDefault()
		if (saving || !editorState || saved) return
		const requestQueryKey = appliedQueryKey
		const requestHref = getCurrentHref()
		saving = true
		message = null
		handle.update()
		try {
			const invalidExpires = readInvalidExpiresAtQuery(requestHref)
			if (invalidExpires) {
				throw new Error(invalidExpires)
			}
			const explicitPackageId = readExplicitPackageId(requestHref)
			const packageResolution = resolvePackageIdForSecretSet({
				scope: editorState.scope,
				explicitPackageId,
				packageOptions: data?.packageOptions ?? [],
			})
			if (packageResolution.error) {
				throw new Error(packageResolution.error)
			}
			const existing = findMatchingSecretForSetup(
				data?.secrets ?? [],
				{
					...editorState,
					packageId: packageResolution.packageId ?? editorState.packageId,
				},
				{ explicitPackageId },
			)
			const current = editorState.currentId ?? existing?.id ?? null
			const policy = resolveSavePolicyFromSetup({
				href: requestHref,
				state: editorState,
				existing,
			})
			const response = await fetch(accountSecretsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'save',
					currentId: current,
					name: editorState.name,
					scope: editorState.scope,
					packageId: packageResolution.packageId,
					description: editorState.description,
					expiresAt: policy.expiresAt,
					value: editorState.value,
					allowedHosts: policy.allowedHosts,
					allowedPackages: policy.allowedPackages,
				}),
			})
			if (response.status === 401) {
				const redirectTo = getCurrentHref()
				window.location.assign(
					`/login?redirectTo=${encodeURIComponent(redirectTo)}`,
				)
				return
			}
			const payload = await readJson<
				AccountSecretsLoaderData & { error?: string; ok?: boolean }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to save secret.')
			}
			// Always refresh loaded secrets so a later save on another link can
			// still resolve currentId, even if this request's query is stale.
			data = payload
			if (requestQueryKey !== appliedQueryKey) return
			saved = true
			savedForQueryKey = requestQueryKey
			editorState = {
				...editorState,
				currentId: payload.selectedSecret?.id ?? editorState.currentId,
				value: '',
			}
		} catch (error) {
			if (requestQueryKey !== appliedQueryKey) return
			message =
				error instanceof Error ? error.message : 'Unable to save secret.'
		} finally {
			if (requestQueryKey === appliedQueryKey) {
				saving = false
				handle.update()
			}
		}
	}

	return () => {
		const currentHref = getCurrentHref()
		applyRouteLoaderData(currentHref)
		const state = ensureEditorState(currentHref)
		const isSavedForCurrent = saved && savedForQueryKey === appliedQueryKey
		const view = readConnectSecretSetView({
			name: state.name,
			saved: isSavedForCurrent,
		})
		const hosts = state.allowedHosts.map((host) => host.trim()).filter(Boolean)
		const packagesById = new Map(
			(data?.packages ?? []).map((entry) => [entry.id, entry]),
		)
		const packageGrants =
			state.scope === 'user'
				? state.allowedPackages
						.map((packageId) => packageId.trim())
						.filter(Boolean)
				: []
		const autofocusKey = getNewSecretValueAutofocusKey(currentHref)
		const setupError =
			readInvalidExpiresAtQuery(currentHref) ??
			resolvePackageIdForSecretSet({
				scope: state.scope,
				explicitPackageId: readExplicitPackageId(currentHref),
				packageOptions: data?.packageOptions ?? [],
			}).error ??
			null

		return (
			<section mix={css(pageCss)} data-testid="connect-secret-set">
				<header mix={css(headerCss)}>
					<span mix={css(pageEyebrowCss)}>Set secret</span>
					<h1 mix={css(pageTitleCss)}>
						{view.saved
							? 'Secret saved'
							: view.hasName
								? 'Set this secret'
								: 'Open a secret setup link'}
					</h1>
					<p mix={css(pageDescriptionCss)}>
						{view.saved
							? 'This secret is saved. Return to your agent and continue.'
							: view.hasName
								? 'Paste the secret value below. Agents cannot set this for you.'
								: 'Open a setup link from Kody to save a secret value such as an API key or personal access token.'}
					</p>
				</header>

				{loadError || setupError ? (
					<section
						mix={css({
							...cardCss,
							border: `1px solid ${colors.danger}`,
						})}
						data-testid="connect-secret-set-error"
					>
						<p mix={css({ margin: 0, color: colors.danger })}>
							{loadError ?? setupError}
						</p>
					</section>
				) : null}

				{message ? (
					<p
						mix={css({ margin: 0, color: colors.danger })}
						data-testid="connect-secret-set-message"
					>
						{message}
					</p>
				) : null}

				{view.showForm && !setupError ? (
					<section mix={css(cardCss)} data-testid="connect-secret-set-card">
						<form
							{...passwordManagerIgnoreProps}
							mix={[
								css({ display: 'grid', gap: spacing.md }),
								on('submit', (event) => {
									void saveSecret(event)
								}),
							]}
						>
							<div mix={css({ display: 'grid', gap: spacing.sm })}>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<span mix={css({ color: colors.textMuted })}>Secret</span>
									<code data-testid="connect-secret-set-name">
										{state.name}
									</code>
								</div>
								{state.description.trim() ? (
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<span mix={css({ color: colors.textMuted })}>
											Description
										</span>
										<span mix={css({ color: colors.text })}>
											{state.description}
										</span>
									</div>
								) : null}
								{state.scope === 'package' ? (
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<span mix={css({ color: colors.textMuted })}>Scope</span>
										<span mix={css({ color: colors.text })}>
											Package
											{state.packageId ? (
												<>
													{' '}
													<code>{state.packageId}</code>
												</>
											) : null}
										</span>
									</div>
								) : null}
								{hosts.length > 0 ? (
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<span mix={css({ color: colors.textMuted })}>
											{hosts.length === 1 ? 'Host' : 'Hosts'}
										</span>
										<ul
											mix={css({
												margin: 0,
												paddingLeft: spacing.lg,
												display: 'grid',
												gap: spacing.xs,
											})}
										>
											{hosts.map((host) => (
												<li key={host}>
													<strong mix={css({ color: colors.text })}>
														{host}
													</strong>
												</li>
											))}
										</ul>
									</div>
								) : null}
								{packageGrants.length > 0 ? (
									<div
										mix={css({ display: 'grid', gap: spacing.xs })}
										data-testid="connect-secret-set-packages"
									>
										<span mix={css({ color: colors.textMuted })}>
											{packageGrants.length === 1
												? 'Allowed package'
												: 'Allowed packages'}
										</span>
										<ul
											mix={css({
												margin: 0,
												paddingLeft: spacing.lg,
												display: 'grid',
												gap: spacing.xs,
											})}
										>
											{packageGrants.map((packageId) => {
												const metadata = packagesById.get(packageId)
												return (
													<li key={packageId}>
														<strong mix={css({ color: colors.text })}>
															{metadata?.kodyId ?? packageId}
														</strong>
														{metadata ? (
															<span mix={css({ color: colors.textMuted })}>
																{' '}
																<code>{packageId}</code>
															</span>
														) : null}
													</li>
												)
											})}
										</ul>
									</div>
								) : null}
								{state.expiresAt.trim() ? (
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<span mix={css({ color: colors.textMuted })}>Expires</span>
										<span mix={css({ color: colors.text })}>
											{state.expiresAt}
										</span>
									</div>
								) : null}
							</div>

							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Secret value</span>
								<div
									mix={css({
										position: 'relative',
										display: 'flex',
										alignItems: 'center',
									})}
								>
									{showSecretValue ? (
										<input
											type="text"
											required
											autoFocus={Boolean(autofocusKey)}
											data-field="secret-value"
											data-testid="connect-secret-set-value"
											{...passwordManagerIgnoreProps}
											value={state.value}
											placeholder="Paste the secret value"
											mix={[
												on('input', (event) => {
													editorState = {
														...state,
														value: event.currentTarget.value,
													}
													handle.update()
												}),
												css({
													...inputCss,
													paddingRight: '4.5rem',
												}),
											]}
										/>
									) : (
										<input
											type="password"
											required
											autoFocus={Boolean(autofocusKey)}
											data-field="secret-value"
											data-testid="connect-secret-set-value"
											{...passwordManagerIgnoreProps}
											value={state.value}
											placeholder="Paste the secret value"
											mix={[
												on('input', (event) => {
													editorState = {
														...state,
														value: event.currentTarget.value,
													}
													handle.update()
												}),
												css({
													...inputCss,
													paddingRight: '4.5rem',
												}),
											]}
										/>
									)}
									<button
										type="button"
										aria-label={
											showSecretValue
												? 'Hide secret value'
												: 'Show secret value'
										}
										mix={[
											on('click', () => {
												showSecretValue = !showSecretValue
												handle.update()
											}),
											css({
												position: 'absolute',
												right: spacing.sm,
												border: 'none',
												background: 'transparent',
												color: colors.textMuted,
												cursor: 'pointer',
												padding: spacing.xs,
											}),
										]}
									>
										{showSecretValue ? 'Hide' : 'Show'}
									</button>
								</div>
							</label>

							<button
								type="submit"
								disabled={saving}
								data-testid="connect-secret-set-save"
								mix={css(primaryButtonCss)}
							>
								{saving ? 'Saving…' : 'Save secret'}
							</button>
						</form>
					</section>
				) : null}

				{view.saved && view.hasName ? (
					<section
						mix={css(cardCss)}
						data-testid="connect-secret-set-saved-card"
					>
						<div mix={css({ display: 'grid', gap: spacing.sm })}>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<span mix={css({ color: colors.textMuted })}>Secret</span>
								<code>{state.name}</code>
							</div>
						</div>
						<a
							href={routes.accountSecrets.href()}
							mix={css(secondaryButtonCss)}
							data-testid="connect-secret-set-back"
						>
							Back to secrets
						</a>
					</section>
				) : view.showBackToSecrets ? (
					<a
						href={routes.accountSecrets.href()}
						mix={css(secondaryButtonCss)}
						data-testid="connect-secret-set-back"
					>
						Back to secrets
					</a>
				) : null}
			</section>
		)
	}
}
