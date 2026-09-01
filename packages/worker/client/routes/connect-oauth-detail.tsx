import { css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	detailGridCss,
	detailItemCss,
	detailLabelCss,
	detailValueCss,
	insetCardCss,
	listCss,
	primaryLinkCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import {
	type ConnectOauthConfig,
	type ConnectOauthHostApprovalLink,
	type StoredIntegrationConfig,
	isSafeExternalUrl,
} from './connect-oauth-config.ts'
import {
	connectOauthAdvancedDetailsCss,
	connectOauthRedirectUriCardCss,
	connectOauthRedirectUriValueCss,
} from './connect-oauth-shared.ts'

export function renderRedirectUriCard(input: {
	config: ConnectOauthConfig | null
	redirectUri: string
}) {
	// Built-in apps are registered by the operator; users have nothing to
	// paste into a provider console.
	if (input.config?.platformAppSlug) return null
	if (!input.redirectUri) return null
	const providerName = input.config?.provider ?? 'your provider'
	return (
		<section mix={css(connectOauthRedirectUriCardCss)}>
			<h2 mix={css(cardTitleCss)}>Redirect URL</h2>
			<p mix={css({ margin: 0, color: colors.text })}>
				Paste this exact URL into {providerName}&apos;s OAuth app settings as
				the redirect (callback) URL.
			</p>
			<pre mix={css(connectOauthRedirectUriValueCss)}>{input.redirectUri}</pre>
			<div>
				<CopyTextButton
					value={input.redirectUri}
					idleLabel="Copy redirect URL"
					variant="primary"
				/>
			</div>
		</section>
	)
}

export function renderProviderInstructions(input: {
	config: ConnectOauthConfig
	hasStoredClientSecret: boolean
}) {
	const instructions = input.config.providerSetupInstructions
	return (
		<>
			<ol mix={css(listCss)}>
				<li>Create an OAuth app in your provider&apos;s developer console.</li>
				<li>Register the exact redirect URI shown above.</li>
				<li>Enable any APIs and scopes the integration needs.</li>
				<li>
					Paste the client ID
					{input.config.flow === 'confidential' && !input.hasStoredClientSecret
						? ' and client secret'
						: ''}{' '}
					below.
				</li>
			</ol>
			{instructions && instructions.trim() ? (
				<p mix={css({ ...insetCardCss, margin: 0, whiteSpace: 'pre-wrap' })}>
					{instructions}
				</p>
			) : null}
			{input.config.dashboardUrl &&
			isSafeExternalUrl(input.config.dashboardUrl) ? (
				<a
					href={input.config.dashboardUrl}
					target="_blank"
					rel="noreferrer noopener"
					mix={css(primaryLinkCss)}
				>
					Open {input.config.provider} developer settings
				</a>
			) : null}
		</>
	)
}

export function renderAllowedHosts(config: ConnectOauthConfig) {
	return (
		<section mix={css(insetCardCss)}>
			<h3 mix={css(sectionTitleCss)}>Allowed hosts</h3>
			<p mix={css(descriptionCss)}>
				Kody only sends this connection&apos;s tokens to these API hosts.
				Approvals are never automatic.
			</p>
			<ul mix={css(listCss)}>
				{config.allowedHosts.map((host) => (
					<li key={host}>{host}</li>
				))}
			</ul>
		</section>
	)
}

export function renderProviderDetails(config: ConnectOauthConfig) {
	return (
		<section mix={css(insetCardCss)}>
			<h3 mix={css(sectionTitleCss)}>Provider details</h3>
			<div mix={css(detailGridCss)}>
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>Authorize URL</span>
					<code mix={css(detailValueCss)}>{config.authorizeUrl}</code>
				</div>
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>Token URL</span>
					<code mix={css(detailValueCss)}>{config.tokenUrl}</code>
				</div>
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>Flow</span>
					<span mix={css(detailValueCss)}>{config.flow}</span>
				</div>
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>PKCE</span>
					<span mix={css(detailValueCss)}>
						{config.usePkce ? 'S256' : 'off'}
					</span>
				</div>
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>Scopes</span>
					<span mix={css(detailValueCss)}>
						{config.scopes.length ? config.scopes.join(' ') : 'None'}
					</span>
				</div>
			</div>
		</section>
	)
}

export function renderExistingIntegrationConfig(
	existingIntegrationConfig: StoredIntegrationConfig | null,
) {
	if (!existingIntegrationConfig) return null
	return (
		<section mix={css(cardCss)}>
			<h2 mix={css(cardTitleCss)}>Existing integration config</h2>
			<p mix={css(descriptionCss)}>
				Loaded your saved connection{' '}
				<code>{existingIntegrationConfig.name}</code>.
			</p>
			<div mix={css(detailGridCss)}>
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>Flow</span>
					<span mix={css(detailValueCss)}>
						{existingIntegrationConfig.flow}
					</span>
				</div>
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>Token URL</span>
					<code mix={css(detailValueCss)}>
						{existingIntegrationConfig.tokenUrl}
					</code>
				</div>
				{existingIntegrationConfig.apiBaseUrl ? (
					<div mix={css(detailItemCss)}>
						<span mix={css(detailLabelCss)}>API base URL</span>
						<code mix={css(detailValueCss)}>
							{existingIntegrationConfig.apiBaseUrl}
						</code>
					</div>
				) : null}
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>Client ID</span>
					<code mix={css(detailValueCss)}>
						{existingIntegrationConfig.clientId}
					</code>
				</div>
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>Client secret secret</span>
					<code mix={css(detailValueCss)}>
						{existingIntegrationConfig.clientSecretSecretName ?? 'Not used'}
					</code>
				</div>
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>Access token secret</span>
					<code mix={css(detailValueCss)}>
						{existingIntegrationConfig.accessTokenSecretName}
					</code>
				</div>
				<div mix={css(detailItemCss)}>
					<span mix={css(detailLabelCss)}>Refresh token secret</span>
					<code mix={css(detailValueCss)}>
						{existingIntegrationConfig.refreshTokenSecretName ?? 'Not used'}
					</code>
				</div>
			</div>
			{existingIntegrationConfig.authorization ? (
				<div mix={css(insetCardCss)}>
					<strong mix={css(sectionTitleCss)}>Authorization metadata</strong>
					<div mix={css(detailGridCss)}>
						<div mix={css(detailItemCss)}>
							<span mix={css(detailLabelCss)}>Authorize URL</span>
							<code mix={css(detailValueCss)}>
								{existingIntegrationConfig.authorization.authorizeUrl}
							</code>
						</div>
						<div mix={css(detailItemCss)}>
							<span mix={css(detailLabelCss)}>Scopes</span>
							<span mix={css(detailValueCss)}>
								{existingIntegrationConfig.authorization.scopes.length
									? existingIntegrationConfig.authorization.scopes.join(' ')
									: 'None'}
							</span>
						</div>
					</div>
				</div>
			) : null}
			<div mix={css(insetCardCss)}>
				<strong mix={css(sectionTitleCss)}>Required hosts</strong>
				{existingIntegrationConfig.requiredHosts.length > 0 ? (
					<ul mix={css(listCss)}>
						{existingIntegrationConfig.requiredHosts.map((host) => (
							<li key={host}>{host}</li>
						))}
					</ul>
				) : (
					<p mix={css(descriptionCss)}>None configured.</p>
				)}
			</div>
		</section>
	)
}

export function renderAdvancedDetails(input: {
	config: ConnectOauthConfig
	existingIntegrationConfig: StoredIntegrationConfig | null
}) {
	return (
		<details
			mix={css(connectOauthAdvancedDetailsCss)}
			data-testid="connect-oauth-advanced"
		>
			<summary>Advanced details</summary>
			<div mix={css({ display: 'grid', gap: spacing.md })}>
				{renderProviderDetails(input.config)}
				{renderAllowedHosts(input.config)}
				{renderExistingIntegrationConfig(input.existingIntegrationConfig)}
			</div>
		</details>
	)
}

export function renderSuccessAdvancedDetails(input: {
	config: ConnectOauthConfig
	accessTokenSaved: boolean
	refreshTokenSaved: boolean
	hostApprovalLinks: Array<ConnectOauthHostApprovalLink>
}) {
	return (
		<details
			mix={css(connectOauthAdvancedDetailsCss)}
			data-testid="connect-oauth-advanced"
		>
			<summary>Advanced details</summary>
			<div mix={css({ display: 'grid', gap: spacing.md })}>
				<div mix={css(detailGridCss)}>
					<div mix={css(detailItemCss)}>
						<span mix={css(detailLabelCss)}>Access token saved</span>
						<strong mix={css(detailValueCss)}>
							{input.accessTokenSaved ? 'Yes' : 'No'}
						</strong>
					</div>
					<div mix={css(detailItemCss)}>
						<span mix={css(detailLabelCss)}>Refresh token saved</span>
						<strong mix={css(detailValueCss)}>
							{input.refreshTokenSaved ? 'Yes' : 'No'}
						</strong>
					</div>
				</div>
				{renderAllowedHosts(input.config)}
				{input.hostApprovalLinks.length > 0 ? (
					<ul mix={css(listCss)}>
						{input.hostApprovalLinks.map((link) => (
							<li key={`${link.secretName}:${link.host}`}>
								<a
									href={link.approvalUrl}
									target="_blank"
									rel="noreferrer noopener"
									mix={css(primaryLinkCss)}
								>
									Approve <code>{link.host}</code> for{' '}
									<code>{link.secretName}</code>
								</a>
							</li>
						))}
					</ul>
				) : null}
				<a
					href="/account/secrets"
					target="_blank"
					rel="noreferrer"
					mix={css(primaryLinkCss)}
				>
					Open account secrets
				</a>
			</div>
		</details>
	)
}
