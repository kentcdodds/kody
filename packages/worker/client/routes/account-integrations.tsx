import { type Handle, css } from 'remix/ui'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
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
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	primaryLinkCss,
	sectionTitleCss,
	stackedPageCss,
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

function formatTimestamp(value: string) {
	return new Date(value).toLocaleString()
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
		<div mix={css({ ...detailItemCss, minWidth: 0 })}>
			<span mix={css(detailLabelCss)}>{label}</span>
			<span
				mix={css({
					...detailValueCss,
					display: 'block',
					maxWidth: '100%',
					minWidth: 0,
					overflowWrap: 'anywhere',
					whiteSpace: 'normal',
					wordBreak: 'break-all',
				})}
			>
				{value}
			</span>
		</div>
	)
}

export function AccountIntegrationsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let email = ''
	let integrations: Array<AccountIntegrationListItem> = []
	let message: string | null = null
	let lastLoadedHref = ''

	async function loadIntegrations(signal: AbortSignal) {
		try {
			const href =
				typeof window === 'undefined'
					? '/account/integrations'
					: window.location.href
			lastLoadedHref = href
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
			email = payload.email
			integrations = payload.integrations
			status = 'ready'
			message = null
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load integrations.'
			handle.update()
		}
	}

	return () => {
		const currentHref =
			typeof window === 'undefined'
				? '/account/integrations'
				: window.location.href
		const isRefreshingForLocationChange =
			status !== 'loading' && currentHref !== lastLoadedHref
		if (status === 'loading' || isRefreshingForLocationChange) {
			handle.queueTask(loadIntegrations)
		}

		return (
			<section
				mix={css({
					...stackedPageCss,
					maxWidth: '76rem',
					margin: '0 auto',
				})}
			>
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>
						{email ? `${email} integrations` : 'Integrations'}
					</h1>
					<p mix={css(pageDescriptionCss)}>
						Review saved OAuth integrations and reconnect providers when tokens
						need to be refreshed.
					</p>
				</header>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading integrations...
					</p>
				) : null}
				{message ? (
					<p
						role="alert"
						mix={css({
							color: status === 'error' ? colors.error : colors.text,
							margin: 0,
						})}
					>
						{message}
					</p>
				) : null}

				{status === 'ready' && integrations.length === 0 ? (
					<section mix={css(cardCss)}>
						<h2 mix={css(cardTitleCss)}>No integrations yet</h2>
						<p mix={css(descriptionCss)}>
							OAuth integrations appear here after Kody saves provider
							configuration through an OAuth setup flow.
						</p>
					</section>
				) : null}

				{status === 'ready' && integrations.length > 0 ? (
					<section
						mix={css({
							display: 'grid',
							gridTemplateColumns: 'repeat(auto-fit, minmax(22rem, 1fr))',
							gap: spacing.lg,
						})}
					>
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

				<p mix={css({ margin: 0 })}>
					<a href="/account" mix={css(primaryLinkCss)}>
						Back to account
					</a>
				</p>
			</section>
		)
	}
}
