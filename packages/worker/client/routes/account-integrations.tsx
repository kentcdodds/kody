import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
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
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { renderByokExplainer } from '#client/routes/byok-explainer.tsx'
import {
	buildCustomIntegrationSetupPrompt,
	buildIntegrationSetupPrompt,
	integrationProviderSuggestions,
} from '#client/routes/integration-provider-catalog.ts'
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

type IntegrationFlow = 'pkce' | 'confidential'

type IntegrationAuthorization = {
	authorizeUrl: string
	scopes: Array<string>
	scopeSeparator?: string | null
	extraAuthorizeParams?: Record<string, string>
}

type AccountIntegrationListItem = {
	name: string
	valueName: string
	tokenUrl: string
	apiBaseUrl?: string | null
	flow: IntegrationFlow
	clientIdValueName: string
	clientSecretSecretName?: string | null
	accessTokenSecretName: string
	refreshTokenSecretName?: string | null
	requiredHosts?: Array<string>
	authorization?: IntegrationAuthorization | null
	createdAt: string
	updatedAt: string
}

type AccountIntegrationsPayload = {
	ok: true
	email: string
	username: string
	integrations: Array<AccountIntegrationListItem>
}

const accountIntegrationsApiPath = '/account/integrations.json'
const accountIntegrationsPath = '/account/integrations'

const providerCatalogGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(22rem, 100%), 1fr))',
	gap: spacing.lg,
}

function isAccountIntegrationsPath(href: string) {
	return new URL(href, 'http://localhost').pathname === accountIntegrationsPath
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
	const payload = await readJson<AccountIntegrationsPayload>(response)
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

function renderIntegrationDetail(label: string, value: string) {
	return (
		<div mix={css(detailItemCss)}>
			<span mix={css(detailLabelCss)}>{label}</span>
			<span mix={css(detailValueCss)}>{value}</span>
		</div>
	)
}

export function AccountIntegrationsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let integrations: Array<AccountIntegrationListItem> = []
	let message: string | null = null
	const loadLatch = createRouteLoadLatch()

	async function loadIntegrations(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
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
			const payload = await readJson<AccountIntegrationsPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load integrations.')
			}
			integrations = payload.integrations
			status = 'ready'
			message = null
			loadLatch.markLoaded(href)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load integrations.'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isAccountIntegrationsPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountIntegrations',
			href,
		)
		if (!routeData) return false
		integrations = routeData.integrations
		status = 'ready'
		message = null
		loadLatch.markLoaded(href)
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// href change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadIntegrations)
		}

		const setupIntro =
			integrations.length === 0
				? 'No integrations yet. Pick a service and copy its prompt into your agent — setup takes a few minutes.'
				: 'Add another service: copy a prompt into your agent.'

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

				{status === 'ready' && integrations.length > 0 ? (
					<section mix={css(providerCatalogGridCss)}>
						{integrations.map((integration) => {
							const connectHref = buildConnectOauthHref(integration)
							return (
								<article key={integration.valueName} mix={css(cardCss)}>
									<header
										mix={css({
											display: 'flex',
											alignItems: 'flex-start',
											justifyContent: 'space-between',
											gap: spacing.md,
										})}
									>
										<div mix={css({ display: 'grid', gap: spacing.xs })}>
											<h2 mix={css(cardTitleCss)}>{integration.name}</h2>
											<p mix={css(descriptionCss)}>
												Stored as {integration.valueName}
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
											{integration.flow}
										</span>
									</header>

									<section mix={css(detailGridCss)}>
										{renderIntegrationDetail('Token URL', integration.tokenUrl)}
										{renderIntegrationDetail(
											'API base URL',
											formatOptional(integration.apiBaseUrl),
										)}
										{renderIntegrationDetail(
											'Authorize URL',
											formatOptional(integration.authorization?.authorizeUrl),
										)}
										{renderIntegrationDetail(
											'Scopes',
											formatList(integration.authorization?.scopes),
										)}
									</section>

									<section mix={css(insetCardCss)}>
										<h3 mix={css(sectionTitleCss)}>Stored names</h3>
										<div mix={css(detailGridCss)}>
											{renderIntegrationDetail(
												'Client ID value',
												integration.clientIdValueName,
											)}
											{renderIntegrationDetail(
												'Client secret',
												formatOptional(integration.clientSecretSecretName),
											)}
											{renderIntegrationDetail(
												'Access token secret',
												integration.accessTokenSecretName,
											)}
											{renderIntegrationDetail(
												'Refresh token secret',
												formatOptional(integration.refreshTokenSecretName),
											)}
										</div>
									</section>

									<section mix={css(detailGridCss)}>
										{renderIntegrationDetail(
											'Required hosts',
											formatList(integration.requiredHosts),
										)}
										{renderIntegrationDetail(
											'Updated',
											formatTimestamp(integration.updatedAt),
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
											This integration does not include authorization details
											yet.
										</p>
									)}
								</article>
							)
						})}
					</section>
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
											<h3 mix={css(cardTitleCss)}>Something else</h3>
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
