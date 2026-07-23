import { formatTimestamp } from '#client/format-timestamp.ts'
import {
	type AccountIntegrationListItem,
	type AccountIntegrationsLoaderData,
} from '#app/loader-data.ts'
import { type Handle, css } from 'remix/ui'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { ProviderIcon } from '#client/provider-icons.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemButton,
	AccountManagementMessage,
	AccountManagementSearchField,
	AccountManagementShell,
	AccountManagementSidebar,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { renderByokExplainer } from '#client/routes/byok-explainer.tsx'
import {
	buildCustomIntegrationSetupPrompt,
	buildIntegrationSetupPrompt,
	integrationProviderSuggestions,
} from '#client/routes/integration-provider-catalog.ts'
import { filterIntegrations } from '#client/routes/integration-filter.ts'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	detailGridCss,
	detailItemCss,
	detailLabelCss,
	detailValueCss,
	getPrimaryButtonCss,
	insetCardCss,
	primaryLinkCss,
	sectionTitleCss,
} from '#client/styles/style-primitives.ts'

const accountIntegrationsApiPath = '/account/integrations.json'
const integrationsRoute = createListDetailRoute('/account/integrations')

const providerCatalogGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(22rem, 100%), 1fr))',
	gap: spacing.lg,
}

const truncatedTextCss = {
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
} as const

/**
 * Latch key for the list payload. Selection segments and the client-side `q`
 * filter do not change the GET response, so keying the latch on the base path
 * avoids spurious refetches when only those URL parts change.
 */
function getDataLatchKey(_href: string) {
	return '/account/integrations'
}

function readSearchFilter(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('q')?.trim() ?? ''
}

export async function accountIntegrationsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(accountIntegrationsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountIntegrationsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load integrations.')
	}
	return { accountIntegrations: payload }
}

function formatList(values: Array<string> | null | undefined) {
	if (!values || values.length === 0) return 'None'
	return values.join(', ')
}

function formatOptional(value: string | null | undefined) {
	return value?.trim() ? value : 'None'
}

function buildConnectOauthHref(integration: AccountIntegrationListItem) {
	const authorization = integration.authorization
	if (!authorization?.authorizeUrl) return null

	const params = new URLSearchParams({ provider: integration.name })
	return `/connect/oauth?${params.toString()}`
}

function PlugIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="1.25em"
			height="1.25em"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M12 22v-5" />
			<path d="M9 8V2" />
			<path d="M15 8V2" />
			<path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
		</svg>
	)
}

function renderIntegrationDetail(label: string, value: string) {
	return (
		<div mix={css(detailItemCss)}>
			<span mix={css(detailLabelCss)}>{label}</span>
			<span mix={css(detailValueCss)}>{value}</span>
		</div>
	)
}

function connectionStatusLabel(integration: AccountIntegrationListItem) {
	return integration.authorization?.authorizeUrl
		? 'OAuth configured'
		: 'No authorization'
}

export function AccountIntegrationsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let integrations: Array<AccountIntegrationListItem> = []
	let message: string | null = null
	const loadLatch = createRouteLoadLatch()

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function buildHrefWithUpdatedSearch(search: string) {
		const nextUrl = new URL(getCurrentHref(), 'http://localhost')
		if (search) nextUrl.searchParams.set('q', search)
		else nextUrl.searchParams.delete('q')
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	async function loadIntegrations(signal: AbortSignal) {
		const href = getCurrentHref()
		const latchKey = getDataLatchKey(href)
		try {
			const response = await fetch(accountIntegrationsApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountIntegrationsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load integrations.')
			}
			if (getDataLatchKey(getCurrentHref()) !== latchKey) return
			integrations = payload.integrations
			status = 'ready'
			message = null
			loadLatch.markLoaded(latchKey)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load integrations.'
			loadLatch.markFailed(latchKey)
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!integrationsRoute.isRoutePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountIntegrations',
			href,
		)
		if (!routeData) return false
		integrations = routeData.integrations
		status = 'ready'
		message = null
		loadLatch.markLoaded(getDataLatchKey(href))
		return true
	}

	return () => {
		const currentHref = getCurrentHref()
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// href change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const latchKey = getDataLatchKey(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref: latchKey,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadIntegrations)
		}

		const selection = integrationsRoute.getSelection(currentHref)
		const search = readSearchFilter(currentHref)
		const setupIntro =
			integrations.length === 0
				? 'No integrations yet. Pick a service and copy its prompt into your agent — setup takes a few minutes.'
				: 'Add another service: copy a prompt into your agent.'
		const filteredIntegrations = filterIntegrations(integrations, search)
		const selectedIntegration =
			integrations.find(
				(integration) => integration.name === selection.selectedId,
			) ?? null
		const showIntegrationNotFound =
			selection.selectedId != null && !selectedIntegration && status === 'ready'
		const connectHref = selectedIntegration
			? buildConnectOauthHref(selectedIntegration)
			: null

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Integrations"
					description="Services Kody can act on for you — built on OAuth apps you create and own."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading integrations...
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<AccountManagementLayout
						sidebarWidth="minmax(18rem, 24rem)"
						sidebar={
							<AccountManagementSidebar
								title="Connected integrations"
								description="Select an integration to view its status or reconnect OAuth."
							>
								<AccountManagementSearchField
									label="Search"
									placeholder="Search names, hosts, scopes, or stored values"
									value={search}
									onInput={(value) => {
										replaceLocation(buildHrefWithUpdatedSearch(value))
									}}
								/>
								{integrations.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No integrations yet. Copy a setup prompt below to get
										started.
									</p>
								) : filteredIntegrations.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No integrations match the current filters.
									</p>
								) : (
									<AccountManagementList>
										{filteredIntegrations.map((integration) => (
											<li
												key={integration.valueName}
												mix={css({ minWidth: 0 })}
											>
												<AccountManagementListItemButton
													active={selection.selectedId === integration.name}
													onClick={() => {
														navigate(
															integrationsRoute.buildDetailHref(
																integration.name,
																getCurrentSearch(),
															),
														)
													}}
												>
													<strong
														mix={css({
															...truncatedTextCss,
															display: 'block',
														})}
													>
														{integration.name}
													</strong>
													<span
														mix={css({
															...truncatedTextCss,
															display: 'block',
															fontSize: typography.fontSize.sm,
															color: colors.textMuted,
														})}
													>
														{connectionStatusLabel(integration)} ·{' '}
														{integration.flow}
													</span>
													<span
														mix={css({
															...truncatedTextCss,
															display: 'block',
															fontSize: typography.fontSize.sm,
															color: colors.textMuted,
														})}
													>
														Stored as {integration.valueName}
													</span>
												</AccountManagementListItemButton>
											</li>
										))}
									</AccountManagementList>
								)}
							</AccountManagementSidebar>
						}
					>
						{selectedIntegration ? (
							<section mix={css(cardCss)}>
								<header
									mix={css({
										display: 'flex',
										alignItems: 'flex-start',
										justifyContent: 'space-between',
										gap: spacing.md,
									})}
								>
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<h2 mix={css(cardTitleCss)}>{selectedIntegration.name}</h2>
										<p mix={css(descriptionCss)}>
											Stored as {selectedIntegration.valueName}
										</p>
									</div>
									<span
										mix={css({
											width: 'max-content',
											padding: `${spacing.xs} ${spacing.sm}`,
											borderRadius: radius.full,
											backgroundColor: colors.primarySoftest,
											color: colors.primaryText,
											fontSize: typography.fontSize.sm,
											fontWeight: typography.fontWeight.medium,
										})}
									>
										{selectedIntegration.flow}
									</span>
								</header>

								<section mix={css(detailGridCss)}>
									{renderIntegrationDetail(
										'Token URL',
										selectedIntegration.tokenUrl,
									)}
									{renderIntegrationDetail(
										'API base URL',
										formatOptional(selectedIntegration.apiBaseUrl),
									)}
									{renderIntegrationDetail(
										'Authorize URL',
										formatOptional(
											selectedIntegration.authorization?.authorizeUrl,
										),
									)}
									{renderIntegrationDetail(
										'Scopes',
										formatList(selectedIntegration.authorization?.scopes),
									)}
								</section>

								<section mix={css(insetCardCss)}>
									<h3 mix={css(sectionTitleCss)}>Stored names</h3>
									<div mix={css(detailGridCss)}>
										{renderIntegrationDetail(
											'Client ID value',
											selectedIntegration.clientIdValueName,
										)}
										{renderIntegrationDetail(
											'Client secret',
											formatOptional(
												selectedIntegration.clientSecretSecretName,
											),
										)}
										{renderIntegrationDetail(
											'Access token secret',
											selectedIntegration.accessTokenSecretName,
										)}
										{renderIntegrationDetail(
											'Refresh token secret',
											formatOptional(
												selectedIntegration.refreshTokenSecretName,
											),
										)}
									</div>
								</section>

								<section mix={css(detailGridCss)}>
									{renderIntegrationDetail(
										'Required hosts',
										formatList(selectedIntegration.requiredHosts),
									)}
									{renderIntegrationDetail(
										'Updated',
										formatTimestamp(selectedIntegration.updatedAt),
									)}
								</section>

								{connectHref ? (
									<div>
										<a
											href={connectHref}
											mix={css({
												...getPrimaryButtonCss(),
												display: 'inline-flex',
												textDecoration: 'none',
											})}
										>
											Reconnect OAuth
										</a>
									</div>
								) : (
									<p mix={css(descriptionCss)}>
										This integration does not include authorization details yet.
									</p>
								)}
							</section>
						) : showIntegrationNotFound ? (
							<div mix={css({ ...cardCss, gap: spacing.sm })}>
								<h2
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									Integration not found
								</h2>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									This integration does not exist for this account or is
									unavailable.
								</p>
							</div>
						) : (
							<div mix={css({ ...cardCss, gap: spacing.sm })}>
								<h2
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									Select an integration
								</h2>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Pick an integration from the list to view its status, or
									reconnect it.
								</p>
							</div>
						)}
					</AccountManagementLayout>
				) : null}

				{status === 'ready' ? (
					<>
						{renderByokExplainer({ image: 'keys' })}

						<section mix={css({ display: 'grid', gap: spacing.lg })}>
							<div mix={css({ display: 'grid', gap: spacing.xs })}>
								<h2 mix={css(sectionTitleCss)}>Set up with your agent</h2>
								<p mix={css(descriptionCss)}>{setupIntro}</p>
							</div>

							<div mix={css(providerCatalogGridCss)}>
								{integrationProviderSuggestions.map((provider) => (
									<article key={provider.id} mix={css(cardCss)}>
										<div mix={css({ display: 'grid', gap: spacing.md })}>
											<div mix={css({ display: 'grid', gap: spacing.xs })}>
												<h3
													mix={css({
														...cardTitleCss,
														display: 'flex',
														alignItems: 'center',
														gap: spacing.sm,
													})}
												>
													<ProviderIcon providerId={provider.id} />
													{provider.name}
												</h3>
												<p mix={css(descriptionCss)}>{provider.tagline}</p>
											</div>
											<div>
												<CopyTextButton
													value={buildIntegrationSetupPrompt(provider)}
													idleLabel="Copy setup prompt"
													variant="secondary"
												/>
											</div>
										</div>
									</article>
								))}

								<article mix={css(cardCss)}>
									<div mix={css({ display: 'grid', gap: spacing.md })}>
										<div mix={css({ display: 'grid', gap: spacing.xs })}>
											<h3
												mix={css({
													...cardTitleCss,
													display: 'flex',
													alignItems: 'center',
													gap: spacing.sm,
												})}
											>
												{PlugIcon()}
												Something else
											</h3>
											<p mix={css(descriptionCss)}>
												If it has an API, your Kody can learn to use it.
											</p>
										</div>
										<div>
											<CopyTextButton
												value={buildCustomIntegrationSetupPrompt()}
												idleLabel="Copy setup prompt"
												variant="secondary"
											/>
										</div>
									</div>
								</article>
							</div>
						</section>
					</>
				) : null}

				<p mix={css({ margin: 0 })}>
					<a href="/account" mix={css(primaryLinkCss)}>
						Back to account
					</a>
				</p>
			</AccountManagementShell>
		)
	}
}
