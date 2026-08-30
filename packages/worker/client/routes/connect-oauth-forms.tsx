import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import {
	buildChangeIntegrationScopesPrompt,
	formatOauthScopeDisclosureLabel,
	resolveOauthScopeMenu,
} from '#universal/oauth-scopes.ts'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	detailValueCss,
	fieldCss,
	fieldLabelCss,
	inputCss,
	insetCardCss,
	listCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { routes } from '#universal/routes.ts'
import {
	type ConnectOauthConfig,
	type ConnectOauthHostApprovalLink,
	type ConnectOauthNextSteps,
	type StoredIntegrationConfig,
} from './connect-oauth-config.ts'
import { renderProviderInstructions } from './connect-oauth-detail.tsx'
import { renderReplaceConfirmation } from './connect-oauth-sections.tsx'
import {
	connectOauthAdvancedDetailsCss,
	connectOauthPrimaryButtonCss,
	connectOauthSecondaryButtonCss,
	connectOauthSuggestionActionsCss,
	connectOauthSuggestionHeaderCss,
	connectOauthTrustedBadgeCss,
} from './connect-oauth-shared.ts'

export function renderScopePicker(input: {
	config: ConnectOauthConfig
	currentStep: 'setup' | 'connect' | 'callback' | 'success'
	offeredScopeMenu: Array<string>
	onToggleScope: (scope: string) => void
}) {
	if (input.currentStep !== 'connect') return null
	const currentConfig = input.config
	const menu = resolveOauthScopeMenu({
		allowedScopes:
			currentConfig.platformAllowedScopes.length > 0
				? currentConfig.platformAllowedScopes
				: input.offeredScopeMenu,
		selectedScopes: currentConfig.scopes,
	})
	if (menu.length === 0) return null
	const selectedCount = currentConfig.scopes.length
	const canAddFromMenu = menu.some(
		(scope) => !currentConfig.scopes.includes(scope),
	)
	return (
		<details
			mix={css(connectOauthAdvancedDetailsCss)}
			data-testid="connect-oauth-scopes"
		>
			<summary>
				{formatOauthScopeDisclosureLabel({
					selectedCount,
					menuCount: menu.length,
				})}
			</summary>
			<div mix={css({ display: 'grid', gap: spacing.sm })}>
				<p mix={css(descriptionCss)}>
					Unchecked scopes are not requested. Defaults stay selected unless you
					change them.
				</p>
				<ul mix={css({ ...listCss, listStyle: 'none', paddingLeft: 0 })}>
					{menu.map((scope) => (
						<li key={scope}>
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
									checked={currentConfig.scopes.includes(scope)}
									mix={on('change', () => input.onToggleScope(scope))}
								/>
								<code mix={css(detailValueCss)}>{scope}</code>
							</label>
						</li>
					))}
				</ul>
				{!canAddFromMenu || currentConfig.platformAllowedScopes.length === 0 ? (
					<div mix={css({ display: 'grid', gap: spacing.sm })}>
						<p mix={css(descriptionCss)}>
							Need access that is not listed? Copy this prompt for your agent.
							It updates the integration&apos;s reconnect scopes, then asks
							whether to reconnect this account.
						</p>
						<CopyTextButton
							value={buildChangeIntegrationScopesPrompt({
								name: currentConfig.providerKey,
								platform: Boolean(currentConfig.platformAppSlug),
								currentScopes: currentConfig.scopes,
								allowedScopes: currentConfig.platformAllowedScopes,
							})}
							idleLabel="Copy scope prompt"
							variant="secondary"
						/>
					</div>
				) : null}
			</div>
		</details>
	)
}

export function ConnectOauthCredentialsForm(
	handle: Handle<{
		config: ConnectOauthConfig
		existingIntegrationConfig: StoredIntegrationConfig | null
		hasStoredClientId: boolean
		hasStoredClientSecret: boolean
		revealStoredClientSecretField: boolean
		clientIdInput: string
		clientSecretInput: string
		submitting: boolean
		onClientIdInput: (value: string) => void
		onClientSecretInput: (value: string) => void
		onRevealStoredClientSecret: () => void
		onSubmit: (event: Event) => void
	}>,
) {
	return () => {
		const props = handle.props
		return (
			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>
					{props.existingIntegrationConfig
						? 'Confirm your app credentials'
						: 'Enter your app credentials'}
				</h2>
				{renderProviderInstructions({
					config: props.config,
					hasStoredClientSecret: props.hasStoredClientSecret,
				})}
				<form
					{...passwordManagerIgnoreProps}
					mix={[
						on('submit', props.onSubmit),
						css({ display: 'grid', gap: spacing.md }),
					]}
				>
					<label mix={css(fieldCss)}>
						<span mix={css(fieldLabelCss)}>Client ID</span>
						<input
							name="oauthClientId"
							required
							{...passwordManagerIgnoreProps}
							value={props.clientIdInput}
							mix={[
								on('input', (event) => {
									props.onClientIdInput(event.currentTarget.value)
								}),
								css(inputCss),
							]}
						/>
					</label>
					<p mix={css(descriptionCss)}>
						{props.hasStoredClientId
							? 'Stored on the OAuth app for this connection.'
							: 'Saved on the OAuth app when you finish connecting.'}
					</p>
					{props.config.flow === 'confidential' ? (
						props.hasStoredClientSecret &&
						!props.revealStoredClientSecretField ? (
							<section mix={css(insetCardCss)}>
								<p mix={css({ margin: 0, color: colors.text })}>
									Using the stored client secret in{' '}
									<code>
										{props.config.clientSecretSecretName ?? 'unknown secret'}
									</code>
									.
								</p>
								<p mix={css(descriptionCss)}>
									You can continue without re-entering it.
								</p>
								<button
									type="button"
									mix={[
										css(connectOauthSecondaryButtonCss),
										on('click', () => {
											props.onRevealStoredClientSecret()
										}),
									]}
								>
									Replace stored client secret
								</button>
							</section>
						) : (
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Client Secret</span>
								<input
									name="oauthClientSecret"
									type="password"
									required
									{...passwordManagerIgnoreProps}
									value={props.clientSecretInput}
									mix={[
										on('input', (event) => {
											props.onClientSecretInput(event.currentTarget.value)
										}),
										css(inputCss),
									]}
								/>
							</label>
						)
					) : null}
					<button
						type="submit"
						disabled={props.submitting}
						mix={css(connectOauthPrimaryButtonCss)}
					>
						Save and continue
					</button>
				</form>
			</section>
		)
	}
}

export function renderConnectStep(input: {
	config: ConnectOauthConfig
	existingConnection: Parameters<
		typeof renderReplaceConfirmation
	>[0]['existingConnection']
	replaceConfirmed: boolean
	renameInput: string
	submitting: boolean
	offeredScopeMenu: Array<string>
	onConfirmReplace: () => void
	onRenameInput: (value: string) => void
	onConnect: () => void
	onToggleScope: (scope: string) => void
	wouldReplace: boolean
}) {
	return (
		<section mix={css(cardCss)}>
			{renderReplaceConfirmation({
				config: input.config,
				existingConnection: input.existingConnection,
				replaceConfirmed: input.replaceConfirmed,
				renameInput: input.renameInput,
				submitting: input.submitting,
				onConfirm: input.onConfirmReplace,
				onRenameInput: input.onRenameInput,
			})}
			<p mix={css({ margin: 0, color: colors.text })}>
				Connecting authorizes your agent — and any code you run or install — to
				act as you on {input.config.provider} with the access you grant. See the{' '}
				<a href="/terms" target="_blank" rel="noreferrer noopener">
					Terms
				</a>
				.
			</p>
			{/* The primary button yields to the replace confirmation so a
			    different-app overwrite is never one ambient click away. */}
			{input.wouldReplace && !input.replaceConfirmed ? null : (
				<button
					type="button"
					disabled={input.submitting}
					mix={[
						on('click', () => {
							input.onConnect()
						}),
						css(connectOauthPrimaryButtonCss),
					]}
				>
					Continue to {input.config.provider}
				</button>
			)}
			{input.wouldReplace && !input.replaceConfirmed
				? null
				: renderScopePicker({
						config: input.config,
						currentStep: 'connect',
						offeredScopeMenu: input.offeredScopeMenu,
						onToggleScope: input.onToggleScope,
					})}
		</section>
	)
}

export function renderSuccessCard(input: {
	config: ConnectOauthConfig
	hostApprovalLinks: Array<ConnectOauthHostApprovalLink>
	nextSteps: ConnectOauthNextSteps | null
	approvingAllHosts: boolean
	onApproveAllHosts: () => void
}) {
	return (
		<section mix={css(cardCss)}>
			{input.hostApprovalLinks.length > 0 ? (
				<div mix={css({ display: 'grid', gap: spacing.md })}>
					<p mix={css({ margin: 0, color: colors.text })}>
						One more step: allow this connection to call {input.config.provider}
						.
					</p>
					<button
						type="button"
						disabled={input.approvingAllHosts}
						mix={[
							on('click', () => {
								input.onApproveAllHosts()
							}),
							css(connectOauthPrimaryButtonCss),
						]}
					>
						{input.approvingAllHosts ? 'Allowing access…' : 'Allow access'}
					</button>
				</div>
			) : null}
			{input.nextSteps ? (
				<div mix={css(insetCardCss)}>
					<h2 mix={css(cardTitleCss)}>What to do next</h2>
					<p mix={css(descriptionCss)}>{input.nextSteps.guidance}</p>
					{input.nextSteps.suggestions.length > 0 ? (
						<ul mix={css(listCss)}>
							{input.nextSteps.suggestions.map((suggestion) => (
								<li key={suggestion.listingId}>
									<div mix={css(connectOauthSuggestionHeaderCss)}>
										<a
											href={suggestion.publicUrl}
											target="_blank"
											rel="noreferrer noopener"
											mix={css(primaryLinkCss)}
										>
											{suggestion.name}
										</a>
										{suggestion.trusted ? (
											<span mix={css(connectOauthTrustedBadgeCss)}>
												Trusted
											</span>
										) : null}
									</div>
									<p mix={css(descriptionCss)}>{suggestion.description}</p>
									<div mix={css(connectOauthSuggestionActionsCss)}>
										<a
											href={suggestion.publicUrl}
											target="_blank"
											rel="noreferrer noopener"
											mix={css(primaryLinkCss)}
										>
											View listing
										</a>
										<CopyTextButton
											value={suggestion.forkPrompt}
											idleLabel="Copy fork prompt"
											variant="secondary"
										/>
									</div>
								</li>
							))}
						</ul>
					) : null}
					<div mix={css(connectOauthSuggestionActionsCss)}>
						<strong mix={css(detailValueCss)}>
							{input.nextSteps.createHelpersCta.label}
						</strong>
						<CopyTextButton
							value={input.nextSteps.createHelpersCta.prompt}
							idleLabel="Copy create prompt"
							variant="secondary"
						/>
					</div>
				</div>
			) : null}
			<a
				href={routes.accountIntegrationDetail.href({
					integrationName: input.config.providerKey,
				})}
				mix={css(primaryLinkCss)}
			>
				View this connection
			</a>
		</section>
	)
}
