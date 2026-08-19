import { formatTimestamp } from '#client/format-timestamp.ts'
import {
	type AccountIntegrationListItem,
	type AccountIntegrationsLoaderData,
	type AccountOauthAppListItem,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { type Handle, type RemixNode, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { ProviderIcon, ProviderMark } from '#client/provider-icons.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	accountDisclosureCss,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import {
	RecordTable,
	RecordTableSearch,
	recordBodyCss,
	recordCellClamp,
} from '#client/routes/record-table.tsx'
import { renderByokExplainer } from '#client/routes/byok-explainer.tsx'
import {
	buildCustomIntegrationSetupPrompt,
	buildIntegrationSetupPrompt,
	integrationProviderSuggestions,
} from '#client/routes/integration-provider-catalog.ts'
import { integrationDisplayName } from '#client/routes/integration-filter.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
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
} from '#universal/styles/style-primitives.ts'

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
	return routes.accountOauthAppDetail.href(
		{ appSlug },
		{ searchParams: new URLSearchParams(search) },
	)
}

function oauthAppTitle(app: AccountOauthAppListItem) {
	return app.label?.trim() || app.provider || app.slug
}

function isBuiltInApp(app: AccountOauthAppListItem) {
	return app.platform === true
}

function integrationListId(app: AccountOauthAppListItem) {
	return isBuiltInApp(app) ? `platform:${app.slug}` : `user:${app.slug}`
}

function findAppForConnection(
	apps: ReadonlyArray<AccountOauthAppListItem>,
	connection: AccountIntegrationListItem,
) {
	return (
		apps.find(
			(app) =>
				app.slug === connection.appSlug &&
				isBuiltInApp(app) === Boolean(connection.platform),
		) ?? null
	)
}

function buildIntegrationHref(app: AccountOauthAppListItem, search = '') {
	if (isBuiltInApp(app)) {
		const first = app.connections[0]
		return first
			? integrationsRoute.buildDetailHref(first.name, search)
			: routes.accountIntegrations.href()
	}
	return buildOauthAppHref(app.slug, search)
}

function accountsConnectedCopy(count: number) {
	if (count === 0) return 'No accounts connected yet.'
	if (count === 1) return '1 account connected.'
	return `${count} accounts connected.`
}

function resolveIntegrationsSelection(input: {
	href: string
	apps: ReadonlyArray<AccountOauthAppListItem>
	integrations: ReadonlyArray<AccountIntegrationListItem>
}) {
	const selectedAppSlug = readSelectedOauthAppSlug(input.href)
	if (selectedAppSlug != null) {
		const app =
			input.apps.find(
				(entry) => entry.slug === selectedAppSlug && !isBuiltInApp(entry),
			) ?? null
		return {
			selectedApp: app,
			highlightedConnectionName: null as string | null,
			missingKind: app ? null : ('integration' as const),
		}
	}
	const connectionName = integrationsRoute.getSelection(input.href).selectedId
	if (connectionName == null) {
		return {
			selectedApp: null,
			highlightedConnectionName: null,
			missingKind: null,
		}
	}
	const connection = input.integrations.find(
		(entry) => entry.name === connectionName,
	)
	if (!connection) {
		return {
			selectedApp: null,
			highlightedConnectionName: connectionName,
			missingKind: 'connection' as const,
		}
	}
	const app = findAppForConnection(input.apps, connection)
	return {
		selectedApp: app,
		highlightedConnectionName: connectionName,
		missingKind: app ? null : ('connection' as const),
	}
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

const clampedCellCss = css(recordCellClamp(26))

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

function buildConnectOauthHref(input: {
	name: string
	platform?: boolean
	appSlug?: string
}) {
	const params = new URLSearchParams({ provider: input.name })
	if (input.platform) {
		params.set('platform', input.appSlug?.trim() || '1')
	}
	return `/connect/oauth?${params.toString()}`
}

function connectActionLabel(status: 'Connected' | 'Needs setup') {
	return status === 'Connected' ? 'Reconnect' : 'Connect'
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

function hostFromUrl(url: string | null | undefined) {
	if (!url) return null
	try {
		return new URL(url).hostname || null
	} catch {
		return null
	}
}

function BuiltInIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			width="0.9em"
			height="0.9em"
			aria-hidden="true"
			fill="currentColor"
		>
			<path d="M5.5 2.5a3.5 3.5 0 0 0-1.4 6.7L2.2 11.1v2.4h2.4l.6-.6H6.8v-1.6H8.4v-1.6h1.2L10.8 8.5A3.5 3.5 0 0 0 5.5 2.5Zm0 1.6a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z" />
		</svg>
	)
}

function renderBuiltInIndicator(input?: { tooltipId?: string }) {
	const tooltipId = input?.tooltipId
	if (!tooltipId) {
		return (
			<span
				data-testid="built-in-indicator"
				role="img"
				aria-label="Provided by Kody"
				title="Provided by Kody"
				mix={css(builtInBadgeCss)}
			>
				{BuiltInIcon()}
			</span>
		)
	}
	return (
		<button
			type="button"
			data-testid="built-in-indicator"
			aria-label="Provided by Kody"
			mix={css(builtInIndicatorCss)}
		>
			{BuiltInIcon()}
			<span id={tooltipId} role="tooltip" aria-hidden="true">
				Provided by Kody
			</span>
		</button>
	)
}

function renderNamedProvider(input: {
	providerKey: string
	label: string
	logoPath?: string | null
	host?: string | null
	builtIn?: boolean
}) {
	return (
		<span
			mix={css({
				display: 'inline-flex',
				alignItems: 'center',
				gap: spacing.sm,
				minWidth: 0,
			})}
		>
			<ProviderMark
				providerKey={input.providerKey}
				label={input.label}
				logoPath={input.logoPath}
				host={input.host}
				size="1.75rem"
			/>
			<span mix={clampedCellCss}>{input.label}</span>
			{input.builtIn ? renderBuiltInIndicator() : null}
		</span>
	)
}

function connectionStatusLabel(integration: AccountIntegrationListItem) {
	return integration.authorization?.authorizeUrl ? 'Connected' : 'Needs setup'
}

function renderAdvancedDetails(body: RemixNode) {
	return (
		<details mix={css(advancedDetailsCss)} data-testid="integration-advanced">
			<summary>Advanced details</summary>
			<div mix={css({ display: 'grid', gap: spacing.md })}>{body}</div>
		</details>
	)
}

const advancedDetailsCss = {
	...accountDisclosureCss,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const builtInBadgeCss = {
	display: 'inline-grid',
	placeContent: 'center',
	width: '1.35rem',
	height: '1.35rem',
	flex: 'none',
	borderRadius: radius.full,
	border: `1px solid ${colors.primary}`,
	backgroundColor: colors.primarySoft,
	color: colors.primaryText,
}

const builtInIndicatorCss = {
	position: 'relative' as const,
	display: 'inline-grid',
	placeContent: 'center',
	width: '1.35rem',
	height: '1.35rem',
	padding: 0,
	appearance: 'none' as const,
	font: 'inherit',
	flex: 'none',
	borderRadius: radius.full,
	border: `1px solid ${colors.primary}`,
	backgroundColor: colors.primarySoft,
	color: colors.primaryText,
	cursor: 'help',
	'& [role="tooltip"]': {
		position: 'absolute' as const,
		left: '50%',
		bottom: 'calc(100% + 0.45rem)',
		transform: 'translateX(-50%)',
		width: 'max-content',
		maxWidth: 'min(16rem, calc(100vw - 2rem))',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderRadius: radius.md,
		backgroundColor: colors.surface,
		color: colors.text,
		fontSize: typography.fontSize.sm,
		fontWeight: 400,
		lineHeight: 1.4,
		textAlign: 'left' as const,
		boxShadow: shadows.md,
		border: `1px solid ${colors.border}`,
		pointerEvents: 'none' as const,
		opacity: 0,
		visibility: 'hidden' as const,
		zIndex: 3,
	},
	'& [role="tooltip"]::after': {
		content: '""',
		position: 'absolute' as const,
		top: '100%',
		left: '50%',
		transform: 'translateX(-50%)',
		border: '6px solid transparent',
		borderTopColor: colors.surface,
	},
	[`${hoverMq} &:hover [role="tooltip"]`]: {
		opacity: 1,
		visibility: 'visible' as const,
	},
	'&:focus-visible [role="tooltip"]': {
		opacity: 1,
		visibility: 'visible' as const,
	},
}

const connectionCardCss = {
	...insetCardCss,
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
}

const highlightedConnectionCardCss = {
	...connectionCardCss,
	borderColor: colors.primary,
	boxShadow: `inset 3px 0 0 ${colors.primary}`,
	borderRadius: `0 ${radius.lg} ${radius.lg} 0`,
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
		lastRotateAppSlug = app ? integrationListId(app) : null
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
				entry.slug === payload.app!.slug && !entry.platform
					? payload.app!
					: entry,
			)
			integrations = integrations.map((entry) =>
				entry.appSlug === payload.app!.slug && !entry.platform
					? {
							...entry,
							clientId: payload.app!.clientId,
							clientSecretSecretName: payload.app!.clientSecretSecretName,
							appLabel: payload.app!.label,
						}
					: entry,
			)
			resetRotateForm(payload.app)
			rotateMessage = 'Rotated shared credentials for this integration.'
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
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadIntegrations)
		}

		const search = readSearchFilter(currentHref)
		const setupIntro =
			apps.length === 0
				? 'No integrations yet. Pick a service and copy its prompt into your agent — setup takes a few minutes.'
				: 'Add another service: copy a prompt into your agent.'
		const filteredApps = filterOauthApps(apps, search)
		const { selectedApp, highlightedConnectionName, missingKind } =
			resolveIntegrationsSelection({
				href: currentHref,
				apps,
				integrations,
			})
		if (selectedApp && lastRotateAppSlug !== integrationListId(selectedApp)) {
			resetRotateForm(selectedApp)
		}
		const showIntegrationNotFound =
			missingKind === 'integration' && status === 'ready'
		const showConnectionNotFound =
			missingKind === 'connection' && status === 'ready'
		const highlightedConnection = highlightedConnectionName
			? (integrations.find(
					(connection) => connection.name === highlightedConnectionName,
				) ?? null)
			: null

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Integrations"
					description="Services you connect so Kody can use them."
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
					<>
						<RecordTable
							mode="pane"
							ariaLabel="Integrations"
							selectedId={selectedApp ? integrationListId(selectedApp) : null}
							countLabel={`${filteredApps.length} of ${apps.length} integrations`}
							emptyLabel={
								apps.length === 0
									? 'No integrations yet. Copy a setup prompt below to get started.'
									: 'No integrations match the current filters.'
							}
							toolbar={
								<RecordTableSearch
									label="Search integrations"
									placeholder="Search names, hosts, or accounts"
									value={search}
									onInput={(value) => {
										replaceLocation(buildHrefWithUpdatedSearch(value))
									}}
								/>
							}
							columns={[
								{ key: 'name', label: 'Integration', primary: true },
								{
									key: 'accounts',
									label: 'Accounts',
									align: 'end',
								},
							]}
							rows={filteredApps.map((app) => ({
								id: integrationListId(app),
								href: buildIntegrationHref(app, getCurrentSearch()),
								cells: {
									name: renderNamedProvider({
										providerKey: app.provider || app.slug,
										label: oauthAppTitle(app),
										logoPath: app.platformLogoPath,
										host: hostFromUrl(app.authorizeUrl ?? app.tokenUrl),
										builtIn: isBuiltInApp(app),
									}),
									accounts: String(app.connectionCount),
								},
							}))}
							record={
								selectedApp ? (
									<section mix={css(recordBodyCss)}>
										<header
											mix={css({
												display: 'grid',
												justifyItems: 'start',
												gap: spacing.sm,
											})}
										>
											<ProviderMark
												providerKey={selectedApp.provider || selectedApp.slug}
												label={oauthAppTitle(selectedApp)}
												logoPath={selectedApp.platformLogoPath}
												host={hostFromUrl(
													selectedApp.authorizeUrl ?? selectedApp.tokenUrl,
												)}
											/>
											<div mix={css({ display: 'grid', gap: spacing.xs })}>
												<h2
													mix={css({
														...cardTitleCss,
														display: 'flex',
														alignItems: 'center',
														gap: spacing.sm,
													})}
												>
													{oauthAppTitle(selectedApp)}
													{isBuiltInApp(selectedApp)
														? renderBuiltInIndicator({
																tooltipId: 'built-in-tip-detail',
															})
														: null}
												</h2>
												<p mix={css(descriptionCss)}>
													{accountsConnectedCopy(
														selectedApp.connections.length,
													)}
												</p>
											</div>
										</header>

										<section mix={css({ display: 'grid', gap: spacing.sm })}>
											<h3 mix={css(sectionTitleCss)}>Connections</h3>
											{selectedApp.connections.length === 0 ? (
												<div
													mix={css({
														display: 'grid',
														gap: spacing.sm,
														justifyItems: 'start',
													})}
												>
													<p mix={css(descriptionCss)}>
														No accounts connected yet.
													</p>
													<a
														href={buildConnectOauthHref({
															name: selectedApp.slug,
															platform: isBuiltInApp(selectedApp),
															appSlug: selectedApp.slug,
														})}
														mix={css({
															...getPillButtonCss({ size: 'sm' }),
															display: 'inline-flex',
															textDecoration: 'none',
														})}
													>
														Connect
													</a>
												</div>
											) : (
												<div
													mix={css({
														display: 'grid',
														gap: spacing.sm,
													})}
												>
													{selectedApp.connections.map((connectionRef) => {
														const connection = integrations.find(
															(entry) => entry.name === connectionRef.name,
														)
														const highlighted =
															connectionRef.name === highlightedConnectionName
														const status = connection
															? connectionStatusLabel(connection)
															: 'Needs setup'
														const connectHref = buildConnectOauthHref({
															name: connectionRef.name,
															platform:
																connection?.platform ??
																isBuiltInApp(selectedApp),
															appSlug: connection?.appSlug ?? selectedApp.slug,
														})
														return (
															<article
																key={connectionRef.name}
																data-testid="integration-connection"
																data-highlighted={
																	highlighted ? 'true' : undefined
																}
																mix={css(
																	highlighted
																		? highlightedConnectionCardCss
																		: connectionCardCss,
																)}
															>
																<div
																	mix={css({
																		display: 'grid',
																		gap: spacing.xs,
																	})}
																>
																	<a
																		href={integrationsRoute.buildDetailHref(
																			connectionRef.name,
																			getCurrentSearch(),
																		)}
																		data-prevent-scroll-reset
																		mix={css(primaryLinkCss)}
																	>
																		{connection
																			? integrationDisplayName(connection)
																			: connectionRef.accountLabel?.trim() ||
																				connectionRef.name}
																	</a>
																	<p
																		mix={css({
																			...descriptionCss,
																			margin: 0,
																		})}
																	>
																		<code>{connectionRef.name}</code>
																		{' · '}
																		{status}
																	</p>
																</div>
																<div>
																	<a
																		href={connectHref}
																		mix={css({
																			...getPillButtonCss({
																				size: 'sm',
																			}),
																			display: 'inline-flex',
																			textDecoration: 'none',
																		})}
																	>
																		{connectActionLabel(status)}
																	</a>
																</div>
															</article>
														)
													})}
												</div>
											)}
										</section>

										{renderAdvancedDetails(
											<>
												<section mix={css(detailGridCss)}>
													{renderIntegrationDetail(
														'Provider',
														selectedApp.provider,
													)}
													{renderIntegrationDetail('Slug', selectedApp.slug)}
													{renderIntegrationDetail(
														'Label',
														formatOptional(selectedApp.label),
													)}
													{renderIntegrationDetail(
														'Client ID',
														selectedApp.clientId,
													)}
													{renderIntegrationDetail(
														'Client-secret secret name',
														formatOptional(selectedApp.clientSecretSecretName),
													)}
													{renderIntegrationDetail(
														'Token URL',
														selectedApp.tokenUrl,
													)}
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
												{highlightedConnection ? (
													<section mix={css(insetCardCss)}>
														<h3 mix={css(sectionTitleCss)}>
															Selected connection
														</h3>
														<div mix={css(detailGridCss)}>
															{renderIntegrationDetail(
																'Connection key',
																highlightedConnection.name,
															)}
															{renderIntegrationDetail(
																'Scopes',
																formatList(
																	highlightedConnection.authorization?.scopes,
																),
															)}
															{renderIntegrationDetail(
																'Required hosts',
																formatList(highlightedConnection.requiredHosts),
															)}
															{renderIntegrationDetail(
																'Access token secret',
																highlightedConnection.accessTokenSecretName,
															)}
															{renderIntegrationDetail(
																'Refresh token secret',
																formatOptional(
																	highlightedConnection.refreshTokenSecretName,
																),
															)}
														</div>
													</section>
												) : null}
												{isBuiltInApp(selectedApp) ? null : (
													<section mix={css(insetCardCss)}>
														<h3 mix={css(sectionTitleCss)}>
															Rotate client credentials
														</h3>
														<p mix={css(descriptionCss)}>
															Rotating credentials updates this shared
															registration once. Every connection below will use
															the new client id and client secret on the next
															authorize or token exchange.
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
																		{connection.accountLabel?.trim() ||
																			connection.name}{' '}
																		(<code>{connection.name}</code>)
																	</li>
																))}
															</ul>
														) : (
															<p mix={css(descriptionCss)}>
																No connections currently share these
																credentials.
															</p>
														)}
														{rotateMessage ? (
															<AccountManagementMessage
																tone={rotateMessageTone}
															>
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
																<span mix={css(fieldLabelCss)}>
																	New client secret
																</span>
																<input
																	type="password"
																	data-field-ring
																	name="oauthAppClientSecret"
																	value={rotateClientSecret}
																	{...passwordManagerIgnoreProps}
																	mix={[
																		on('input', (event) => {
																			rotateClientSecret =
																				event.currentTarget.value
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
																		rotateConfirmed =
																			event.currentTarget.checked
																		handle.update()
																	})}
																/>
																<span>
																	I understand this updates credentials for
																	{selectedApp.connections.length === 0
																		? ' this integration'
																		: selectedApp.connections.length === 1
																			? ' 1 connection on this integration'
																			: ` all ${selectedApp.connections.length} connections on this integration`}
																	.
																</span>
															</label>
															<div>
																<button
																	type="submit"
																	disabled={
																		rotateStatus === 'saving' ||
																		!rotateConfirmed
																	}
																	mix={css(dangerButtonCss)}
																>
																	{rotateStatus === 'saving'
																		? 'Rotating...'
																		: 'Rotate credentials'}
																</button>
															</div>
														</form>
													</section>
												)}
											</>,
										)}
									</section>
								) : showConnectionNotFound ? (
									<div
										mix={css({ ...recordBodyCss, gap: spacing.sm })}
										data-testid="connection-not-found"
									>
										<h2
											mix={css({
												margin: 0,
												fontSize: typography.fontSize.lg,
												fontWeight: typography.fontWeight.semibold,
												color: colors.text,
											})}
										>
											Connection not found
										</h2>
										<p mix={css({ margin: 0, color: colors.textMuted })}>
											This connection does not exist for this account or is
											unavailable.
										</p>
									</div>
								) : showIntegrationNotFound ? (
									<div
										mix={css({ ...recordBodyCss, gap: spacing.sm })}
										data-testid="integration-not-found"
									>
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
								) : null
							}
						/>
					</>
				) : null}

				{status === 'ready' ? (
					<>
						<details
							mix={css(advancedDetailsCss)}
							data-testid="integrations-how-connections-work"
						>
							<summary>How connections work</summary>
							{renderByokExplainer({ image: 'keys' })}
						</details>

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
