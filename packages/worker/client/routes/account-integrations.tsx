import { formatTimestamp } from '#client/format-timestamp.ts'
import {
	type AccountIntegrationListItem,
	type AccountIntegrationsLoaderData,
	type AccountOauthAppListItem,
} from '#app/loader-data.ts'
import { routes } from '#app/routes.ts'
import { type Handle, css } from 'remix/ui'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
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
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import { renderByokExplainer } from '#client/routes/byok-explainer.tsx'
import {
	buildCustomIntegrationSetupPrompt,
	buildIntegrationSetupPrompt,
	integrationProviderSuggestions,
} from '#client/routes/integration-provider-catalog.ts'
import {
	filterIntegrations,
	groupIntegrationsByApp,
	integrationDisplayName,
	oauthAppDisplayName,
} from '#client/routes/integration-filter.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import {
	colors,
	radius,
	spacing,
	transitions,
	typography,
} from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	detailGridCss,
	detailItemCss,
	detailLabelCss,
	detailValueCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getPillButtonCss,
	hoverMq,
	insetCardCss,
	primaryLinkCss,
	sectionTitleCss,
} from '#client/styles/style-primitives.ts'

const accountIntegrationsApiPath = routes.accountIntegrationsApi.href()
const integrationsRoute = createListDetailRoute('/account/integrations')
const oauthAppsPathPrefix = `${routes.accountIntegrations.href()}/apps/`

function decodePathSegment(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function readSelectedOauthAppSlug(href: string): string | null {
	const pathname = new URL(href, 'http://localhost').pathname
	if (!pathname.startsWith(oauthAppsPathPrefix)) return null
	const segment = pathname.slice(oauthAppsPathPrefix.length)
	if (!segment || segment.includes('/')) return null
	return decodePathSegment(segment)
}

function buildOauthAppHref(appSlug: string, search = '') {
	return `${routes.accountOauthAppDetail.href({ appSlug })}${search}`
}

function oauthAppTitle(app: AccountOauthAppListItem) {
	return app.label?.trim() || app.provider || app.slug
}

function filterOauthApps(
	apps: ReadonlyArray<AccountOauthAppListItem>,
	query: string,
) {
	return apps.filter((app) =>
		matchesSearchQuery(query, [
			app.slug,
			app.provider,
			app.label,
			app.clientId,
			app.clientSecretSecretName,
			app.tokenUrl,
			app.authorizeUrl,
			app.apiBaseUrl,
			...app.connections.map((connection) => connection.name),
			...app.connections.map((connection) => connection.accountLabel),
		]),
	)
}

const dangerButtonCss = getDangerPillCss({ size: 'sm' })

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
	let apps: Array<AccountOauthAppListItem> = []
	let message: string | null = null
	let rotateClientId = ''
	let rotateClientSecret = ''
	let rotateConfirmed = false
	let rotateStatus: 'idle' | 'saving' = 'idle'
	let rotateMessage: string | null = null
	let rotateMessageTone: 'error' | 'info' = 'info'
	let lastRotateAppSlug: string | null = null
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

	function resetRotateForm(app: AccountOauthAppListItem | null) {
		rotateClientId = app?.clientId ?? ''
		rotateClientSecret = ''
		rotateConfirmed = false
		rotateStatus = 'idle'
		rotateMessage = null
		rotateMessageTone = 'info'
		lastRotateAppSlug = app?.slug ?? null
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
			apps = payload.apps ?? []
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
		apps = routeData.apps ?? []
		status = 'ready'
		message = null
		loadLatch.markLoaded(getDataLatchKey(href))
		return true
	}

	async function submitRotateCredentials(app: AccountOauthAppListItem) {
		if (rotateStatus === 'saving') return
		const clientId = rotateClientId.trim()
		const clientSecret = rotateClientSecret.trim()
		if (!rotateConfirmed) {
			rotateMessage =
				'Confirm that every connection on this app should use the new credentials.'
			rotateMessageTone = 'error'
			handle.update()
			return
		}
		if (!clientId && !clientSecret) {
			rotateMessage = 'Provide a new client id and/or client secret.'
			rotateMessageTone = 'error'
			handle.update()
			return
		}
		if (clientId === app.clientId && !clientSecret) {
			rotateMessage = 'Enter a new client id or client secret to rotate.'
			rotateMessageTone = 'error'
			handle.update()
			return
		}
		rotateStatus = 'saving'
		rotateMessage = null
		handle.update()
		try {
			const response = await fetch(accountIntegrationsApiPath, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'rotate_oauth_app_credentials',
					appSlug: app.slug,
					...(clientId ? { clientId } : {}),
					...(clientSecret ? { clientSecret } : {}),
					confirm: true,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{
				ok: boolean
				error?: string
				app?: AccountOauthAppListItem
			}>(response)
			if (!response.ok || !payload?.ok || !payload.app) {
				throw new Error(payload?.error || 'Unable to rotate credentials.')
			}
			apps = apps.map((entry) =>
				entry.slug === payload.app!.slug ? payload.app! : entry,
			)
			integrations = integrations.map((entry) =>
				entry.appSlug === payload.app!.slug
					? {
							...entry,
							clientId: payload.app!.clientId,
							clientSecretSecretName: payload.app!.clientSecretSecretName,
							appLabel: payload.app!.label,
						}
					: entry,
			)
			resetRotateForm(payload.app)
			rotateMessage = 'Rotated shared OAuth app credentials.'
			rotateMessageTone = 'info'
			handle.update()
		} catch (error) {
			rotateStatus = 'idle'
			rotateMessage =
				error instanceof Error ? error.message : 'Unable to rotate credentials.'
			rotateMessageTone = 'error'
			handle.update()
		}
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
		const selectedAppSlug = readSelectedOauthAppSlug(currentHref)
		const search = readSearchFilter(currentHref)
		const setupIntro =
			integrations.length === 0
				? 'No integrations yet. Pick a service and copy its prompt into your agent — setup takes a few minutes.'
				: 'Add another service: copy a prompt into your agent.'
		const filteredIntegrations = filterIntegrations(integrations, search)
		const filteredApps = filterOauthApps(apps, search)
		const connectionAppSlugs = new Set(
			filteredIntegrations.map((integration) => integration.appSlug),
		)
		const connectionlessApps = filteredApps.filter(
			(app) => app.connectionCount === 0 && !connectionAppSlugs.has(app.slug),
		)
		const selectedIntegration =
			selectedAppSlug == null
				? (integrations.find(
						(integration) => integration.name === selection.selectedId,
					) ?? null)
				: null
		const selectedApp =
			selectedAppSlug != null
				? (apps.find((app) => app.slug === selectedAppSlug) ?? null)
				: null
		if (selectedApp && lastRotateAppSlug !== selectedApp.slug) {
			resetRotateForm(selectedApp)
		}
		const selectedAppConnectionCount = selectedIntegration
			? integrations.filter(
					(entry) => entry.appSlug === selectedIntegration.appSlug,
				).length
			: 0
		const showIntegrationNotFound =
			selectedAppSlug == null &&
			selection.selectedId != null &&
			!selectedIntegration &&
			status === 'ready'
		const showOauthAppNotFound =
			selectedAppSlug != null && !selectedApp && status === 'ready'
		const connectHref = selectedIntegration
			? buildConnectOauthHref(selectedIntegration)
			: null
		const hasSidebarMatches =
			filteredIntegrations.length > 0 || connectionlessApps.length > 0

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
								description="Select a connection or open its shared OAuth app to view status, reconnect, or rotate client credentials."
							>
								<AccountManagementSearchField
									label="Search"
									placeholder="Search names, hosts, scopes, or client IDs"
									value={search}
									onInput={(value) => {
										replaceLocation(buildHrefWithUpdatedSearch(value))
									}}
								/>
								{integrations.length === 0 && apps.length === 0 ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No integrations yet. Copy a setup prompt below to get
										started.
									</p>
								) : !hasSidebarMatches ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										No integrations match the current filters.
									</p>
								) : (
									<div mix={css({ display: 'grid', gap: spacing.md })}>
										{groupIntegrationsByApp(filteredIntegrations).map(
											(group) => {
												const appTitle = oauthAppDisplayName(group)
												const showAppHeader = group.connections.length > 1
												const appActive = selectedAppSlug === group.appSlug
												return (
													<div
														key={group.appSlug}
														mix={css({ display: 'grid', gap: spacing.xs })}
													>
														<button
															type="button"
															mix={[
																on('click', () => {
																	navigate(
																		buildOauthAppHref(
																			group.appSlug,
																			getCurrentSearch(),
																		),
																	)
																}),
																css({
																	display: 'grid',
																	gap: spacing.xs,
																	padding: `${spacing.xs} ${spacing.sm}`,
																	border: 'none',
																	borderRadius: radius.md,
																	backgroundColor: appActive
																		? colors.primarySoftest
																		: 'transparent',
																	color: colors.text,
																	textAlign: 'left',
																	cursor: 'pointer',
																	transition: `background-color ${transitions.fast}, scale ${transitions.fast}`,
																	// Selecting a connection swaps the panel
																	// beside this list, which is easy to miss —
																	// the press itself has to register.
																	'&:active': { scale: '0.98' },
																	[hoverMq]: {
																		'&:hover': {
																			backgroundColor: colors.primarySoftest,
																		},
																	},
																	'@media (prefers-reduced-motion: reduce)': {
																		'&:active': { scale: 'none' },
																	},
																}),
															]}
														>
															<strong
																mix={css({
																	...truncatedTextCss,
																	fontSize: typography.fontSize.sm,
																	color: colors.text,
																})}
															>
																{appTitle}
															</strong>
															<span
																mix={css({
																	fontSize: typography.fontSize.sm,
																	color: colors.textMuted,
																})}
															>
																{showAppHeader
																	? `${group.connections.length} connections · shared OAuth app`
																	: 'OAuth app'}
															</span>
														</button>
														<AccountManagementList>
															{group.connections.map((integration) => (
																<li
																	key={integration.name}
																	mix={css({ minWidth: 0 })}
																>
																	<AccountManagementListItemButton
																		active={
																			selection.selectedId === integration.name
																		}
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
																			{integrationDisplayName(integration)}
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
																		{showAppHeader ? (
																			<span
																				mix={css({
																					...truncatedTextCss,
																					display: 'block',
																					fontSize: typography.fontSize.sm,
																					color: colors.textMuted,
																				})}
																			>
																				{integration.name}
																			</span>
																		) : (
																			<span
																				mix={css({
																					...truncatedTextCss,
																					display: 'block',
																					fontSize: typography.fontSize.sm,
																					color: colors.textMuted,
																				})}
																			>
																				{appTitle}
																			</span>
																		)}
																	</AccountManagementListItemButton>
																</li>
															))}
														</AccountManagementList>
													</div>
												)
											},
										)}
										{connectionlessApps.map((app) => (
											<div
												key={app.slug}
												mix={css({ display: 'grid', gap: spacing.xs })}
											>
												<button
													type="button"
													mix={[
														on('click', () => {
															navigate(
																buildOauthAppHref(app.slug, getCurrentSearch()),
															)
														}),
														css({
															display: 'grid',
															gap: spacing.xs,
															padding: `${spacing.xs} ${spacing.sm}`,
															border: 'none',
															borderRadius: radius.md,
															backgroundColor:
																selectedAppSlug === app.slug
																	? colors.primarySoftest
																	: 'transparent',
															color: colors.text,
															textAlign: 'left',
															cursor: 'pointer',
															transition: `background-color ${transitions.fast}, scale ${transitions.fast}`,
															// Selecting an app swaps the panel beside this
															// list, which is easy to miss — the press itself
															// has to register.
															'&:active': { scale: '0.98' },
															[hoverMq]: {
																'&:hover': {
																	backgroundColor: colors.primarySoftest,
																},
															},
															'@media (prefers-reduced-motion: reduce)': {
																'&:active': { scale: 'none' },
															},
														}),
													]}
												>
													<strong
														mix={css({
															...truncatedTextCss,
															fontSize: typography.fontSize.sm,
															color: colors.text,
														})}
													>
														{oauthAppTitle(app)}
													</strong>
													<span
														mix={css({
															fontSize: typography.fontSize.sm,
															color: colors.textMuted,
														})}
													>
														OAuth app · no connections yet
													</span>
												</button>
											</div>
										))}
									</div>
								)}
							</AccountManagementSidebar>
						}
					>
						{selectedApp ? (
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
										<h2 mix={css(cardTitleCss)}>
											{oauthAppTitle(selectedApp)}
										</h2>
										<p mix={css(descriptionCss)}>
											Shared OAuth app <code>{selectedApp.slug}</code>
											{selectedApp.connections.length > 0
												? ` · ${selectedApp.connections.length} connection${selectedApp.connections.length === 1 ? '' : 's'}`
												: ' · no connections yet'}
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
										{selectedApp.flow}
									</span>
								</header>

								<section mix={css(detailGridCss)}>
									{renderIntegrationDetail('Provider', selectedApp.provider)}
									{renderIntegrationDetail('Slug', selectedApp.slug)}
									{renderIntegrationDetail(
										'Label',
										formatOptional(selectedApp.label),
									)}
									{renderIntegrationDetail('Client ID', selectedApp.clientId)}
									{renderIntegrationDetail(
										'Client-secret secret name',
										formatOptional(selectedApp.clientSecretSecretName),
									)}
									{renderIntegrationDetail('Token URL', selectedApp.tokenUrl)}
									{renderIntegrationDetail(
										'Authorize URL',
										formatOptional(selectedApp.authorizeUrl),
									)}
									{renderIntegrationDetail(
										'API base URL',
										formatOptional(selectedApp.apiBaseUrl),
									)}
									{renderIntegrationDetail('Flow', selectedApp.flow)}
									{renderIntegrationDetail(
										'PKCE',
										selectedApp.usePkce == null
											? selectedApp.flow === 'pkce'
												? 'Default on'
												: 'Default off'
											: selectedApp.usePkce
												? 'Enabled'
												: 'Disabled',
									)}
									{renderIntegrationDetail(
										'Token exchange style',
										formatOptional(selectedApp.tokenExchangeStyle),
									)}
									{renderIntegrationDetail(
										'Created',
										formatTimestamp(selectedApp.createdAt),
									)}
									{renderIntegrationDetail(
										'Updated',
										formatTimestamp(selectedApp.updatedAt),
									)}
								</section>

								<section mix={css(insetCardCss)}>
									<h3 mix={css(sectionTitleCss)}>Connections using this app</h3>
									{selectedApp.connections.length === 0 ? (
										<p mix={css(descriptionCss)}>
											No connections yet. Finish connect setup for a provider
											that uses this app, or reconnect from a connection detail
											page.
										</p>
									) : (
										<ul
											mix={css({
												margin: 0,
												paddingLeft: spacing.lg,
												display: 'grid',
												gap: spacing.xs,
											})}
										>
											{selectedApp.connections.map((connection) => (
												<li key={connection.name}>
													<a
														href={integrationsRoute.buildDetailHref(
															connection.name,
															getCurrentSearch(),
														)}
														mix={css(primaryLinkCss)}
													>
														{connection.accountLabel?.trim() || connection.name}
													</a>
													{connection.accountLabel?.trim() ? (
														<span
															mix={css({
																color: colors.textMuted,
																fontSize: typography.fontSize.sm,
															})}
														>
															{' '}
															(<code>{connection.name}</code>)
														</span>
													) : null}
												</li>
											))}
										</ul>
									)}
								</section>

								<section mix={css(insetCardCss)}>
									<h3 mix={css(sectionTitleCss)}>Rotate client credentials</h3>
									<p mix={css(descriptionCss)}>
										Rotating credentials updates this shared OAuth app once.
										Every connection below will use the new client id and client
										secret on the next authorize or token exchange.
									</p>
									{selectedApp.connections.length > 0 ? (
										<ul
											mix={css({
												margin: 0,
												paddingLeft: spacing.lg,
												display: 'grid',
												gap: spacing.xs,
												color: colors.text,
											})}
										>
											{selectedApp.connections.map((connection) => (
												<li key={`rotate-${connection.name}`}>
													{connection.accountLabel?.trim() || connection.name} (
													<code>{connection.name}</code>)
												</li>
											))}
										</ul>
									) : (
										<p mix={css(descriptionCss)}>
											No connections currently share these credentials.
										</p>
									)}
									{rotateMessage ? (
										<AccountManagementMessage tone={rotateMessageTone}>
											{rotateMessage}
										</AccountManagementMessage>
									) : null}
									<form
										mix={[
											on('submit', (event) => {
												event.preventDefault()
												void submitRotateCredentials(selectedApp)
											}),
											css({
												display: 'grid',
												gap: spacing.md,
												marginTop: spacing.sm,
											}),
										]}
									>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>
												Client ID (optional to keep current)
											</span>
											<input
												type="text"
												data-field-ring
												name="oauthAppClientId"
												value={rotateClientId}
												{...passwordManagerIgnoreProps}
												mix={[
													on('input', (event) => {
														rotateClientId = event.currentTarget.value
														handle.update()
													}),
													css(accountInputCss),
												]}
											/>
										</label>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>New client secret</span>
											<input
												type="password"
												data-field-ring
												name="oauthAppClientSecret"
												value={rotateClientSecret}
												{...passwordManagerIgnoreProps}
												mix={[
													on('input', (event) => {
														rotateClientSecret = event.currentTarget.value
														handle.update()
													}),
													css(accountInputCss),
												]}
											/>
										</label>
										<label
											mix={css({
												display: 'flex',
												alignItems: 'flex-start',
												gap: spacing.sm,
												color: colors.text,
												fontSize: typography.fontSize.sm,
											})}
										>
											<input
												type="checkbox"
												checked={rotateConfirmed}
												mix={on('change', (event) => {
													rotateConfirmed = event.currentTarget.checked
													handle.update()
												})}
											/>
											<span>
												I understand this updates credentials for
												{selectedApp.connections.length === 0
													? ' this OAuth app'
													: selectedApp.connections.length === 1
														? ' 1 connection that shares this OAuth app'
														: ` all ${selectedApp.connections.length} connections that share this OAuth app`}
												.
											</span>
										</label>
										<div>
											<button
												type="submit"
												disabled={rotateStatus === 'saving' || !rotateConfirmed}
												mix={css(dangerButtonCss)}
											>
												{rotateStatus === 'saving'
													? 'Rotating...'
													: 'Rotate credentials'}
											</button>
										</div>
									</form>
								</section>
							</section>
						) : selectedIntegration ? (
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
										<h2 mix={css(cardTitleCss)}>
											{integrationDisplayName(selectedIntegration)}
										</h2>
										<p mix={css(descriptionCss)}>
											Connection <code>{selectedIntegration.name}</code> on
											OAuth app{' '}
											<a
												href={buildOauthAppHref(
													selectedIntegration.appSlug,
													getCurrentSearch(),
												)}
												mix={css(primaryLinkCss)}
											>
												<code>{selectedIntegration.appSlug}</code>
											</a>
											{selectedAppConnectionCount > 1
												? ` · ${selectedAppConnectionCount} connections share this app`
												: ''}
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
									<h3 mix={css(sectionTitleCss)}>OAuth app & secrets</h3>
									<div mix={css(detailGridCss)}>
										{renderIntegrationDetail(
											'Client ID',
											selectedIntegration.clientId,
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
									<p mix={css({ ...descriptionCss, marginTop: spacing.sm })}>
										<a
											href={buildOauthAppHref(
												selectedIntegration.appSlug,
												getCurrentSearch(),
											)}
											mix={css(primaryLinkCss)}
										>
											Manage OAuth app
										</a>
									</p>
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
												...getPillButtonCss({ size: 'sm' }),
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
						) : showOauthAppNotFound ? (
							<div mix={css({ ...cardCss, gap: spacing.sm })}>
								<h2
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									OAuth app not found
								</h2>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									This OAuth app does not exist for this account or is
									unavailable.
								</p>
							</div>
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
									Pick a connection or OAuth app from the list to view its
									status, reconnect, or rotate shared credentials.
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
												{provider.guideSlug ? (
													<p
														mix={css({
															margin: 0,
															fontSize: typography.fontSize.sm,
														})}
													>
														<a
															href={routes.guideDetail.href({
																slug: provider.guideSlug,
															})}
															mix={css(primaryLinkCss)}
														>
															Setup guide
														</a>
													</p>
												) : null}
											</div>
											<div>
												<CopyTextButton
													value={buildIntegrationSetupPrompt(provider)}
													idleLabel="Copy setup prompt"
													variant="ghost"
													size="sm"
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
												variant="ghost"
												size="sm"
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
