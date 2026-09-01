import { type ConnectOauthExistingConnection } from '#universal/loader-data.ts'
import { css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { buildIncompleteConnectOauthPrompt } from '#universal/oauth-scopes.ts'
import { isConnectOauthCallbackUrl } from '#universal/oauth-connect.ts'
import { on } from '#client/event-mixin.ts'
import { ProviderMark } from '#client/provider-icons.tsx'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	getAccentCalloutCss,
	getSecondaryButtonCss,
	inputCss,
	insetCardCss,
	listCss,
	pageDescriptionCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	connectOauthChooserFilterMinOptions,
	connectOauthChooserListMaxHeight,
	connectOauthChooserOptionMarkSize,
	filterConnectOauthChooserOptions,
} from './connect-oauth-chooser-list.ts'
import { type ConnectOauthConfig } from './connect-oauth-config.ts'
import {
	type ConnectOauthChooserOption,
	type ConnectOauthStatusTone,
	type ConnectOauthStep,
} from './connect-oauth-shared.ts'

export function wouldReplaceDifferentApp(input: {
	config: ConnectOauthConfig | null
	existingConnection: ConnectOauthExistingConnection | null
}) {
	if (!input.config || !input.existingConnection) return false
	return input.existingConnection.lane === 'platform'
}

export function renderReplaceConfirmation(input: {
	config: ConnectOauthConfig
	existingConnection: ConnectOauthExistingConnection | null
	replaceConfirmed: boolean
	submitting: boolean
	onConfirm: () => void
}) {
	if (
		!wouldReplaceDifferentApp({
			config: input.config,
			existingConnection: input.existingConnection,
		}) ||
		input.replaceConfirmed
	) {
		return null
	}
	const existingLabel =
		input.existingConnection?.lane === 'platform'
			? `the built-in ${input.existingConnection.appSlug} integration`
			: 'your own OAuth app'
	return (
		<div mix={css(insetCardCss)}>
			<p mix={css({ margin: 0, color: colors.text, fontWeight: 600 })}>
				You already have a {input.config.providerKey} connection using{' '}
				{existingLabel}.
			</p>
			<p mix={css(descriptionCss)}>
				Continuing replaces its tokens and scopes. You can also keep it and
				connect under a different name.
			</p>
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
					disabled={input.submitting}
					mix={[
						on('click', () => {
							input.onConfirm()
						}),
						css(getSecondaryButtonCss()),
					]}
					data-testid="connect-replace-confirm"
				>
					Replace {input.config.providerKey}
				</button>
			</div>
		</div>
	)
}

export function renderCallbackPending() {
	return (
		<section mix={css(cardCss)} data-testid="connect-oauth-callback">
			<p mix={css({ margin: 0, color: colors.text })}>
				Finishing the connection…
			</p>
		</section>
	)
}

export function renderChooser(input: {
	chooserOptions: Array<ConnectOauthChooserOption>
	chooserFilter: string
	onFilterChange: (value: string) => void
}) {
	const showFilter =
		input.chooserOptions.length > connectOauthChooserFilterMinOptions
	const visibleOptions = showFilter
		? filterConnectOauthChooserOptions(
				input.chooserOptions,
				input.chooserFilter,
			)
		: input.chooserOptions
	return (
		<section mix={css(cardCss)} data-testid="connect-oauth-chooser">
			<p mix={css({ margin: 0, color: colors.text })}>
				Pick a service to connect. Saved integrations start from a name alone.
			</p>
			{showFilter ? (
				<input
					type="search"
					value={input.chooserFilter}
					placeholder="Filter services"
					aria-label="Filter services"
					data-testid="connect-oauth-chooser-filter"
					mix={[
						css(inputCss),
						on('input', (event) => {
							const target = event.currentTarget
							if (target instanceof HTMLInputElement) {
								input.onFilterChange(target.value)
							}
						}),
					]}
				/>
			) : null}
			{input.chooserOptions.length > 0 ? (
				visibleOptions.length > 0 ? (
					<ul
						data-testid="connect-oauth-chooser-list"
						mix={css({
							...listCss,
							listStyle: 'none',
							paddingLeft: 0,
							margin: 0,
							display: 'grid',
							gap: spacing.sm,
							maxHeight: connectOauthChooserListMaxHeight,
							overflowY: 'auto',
						})}
					>
						{visibleOptions.map((option) => (
							<li key={option.id}>
								<a
									href={option.href}
									mix={css({
										...insetCardCss,
										display: 'grid',
										gridTemplateColumns: 'auto 1fr',
										gap: spacing.sm,
										alignItems: 'center',
										textDecoration: 'none',
										color: 'inherit',
									})}
								>
									<ProviderMark
										providerKey={option.providerKey}
										label={option.label}
										logoPath={option.logoPath}
										autoLogoPath={option.autoLogoPath}
										size={connectOauthChooserOptionMarkSize}
									/>
									<span mix={css({ display: 'grid', gap: spacing.xs })}>
										<strong mix={css({ color: colors.text })}>
											{option.label}
										</strong>
										<span mix={css(descriptionCss)}>{option.detail}</span>
									</span>
								</a>
							</li>
						))}
					</ul>
				) : (
					<p mix={css(descriptionCss)}>No services match that filter.</p>
				)
			) : (
				<p mix={css(descriptionCss)}>No saved connections are ready yet.</p>
			)}
			<p mix={css(descriptionCss)}>
				Need a service that is not listed?{' '}
				<a href="/guides/oauth" mix={css(primaryLinkCss)}>
					Bring your own OAuth app
				</a>
				.
			</p>
		</section>
	)
}

export function renderIncompleteConfig(provider: string) {
	return (
		<section mix={css(cardCss)} data-testid="connect-oauth-incomplete">
			<p mix={css({ margin: 0, color: colors.text })}>
				Kody does not have enough OAuth configuration to connect {provider} from
				this URL.
			</p>
			<p mix={css(descriptionCss)}>
				Copy this prompt for your agent so it can fill in the authorize and
				token URLs and send you a complete link.
			</p>
			<CopyTextButton
				value={buildIncompleteConnectOauthPrompt({ provider })}
				idleLabel="Copy setup prompt"
				variant="primary"
			/>
			<p mix={css(descriptionCss)}>
				Or start from a known service on the{' '}
				<a href="/connect/oauth" mix={css(primaryLinkCss)}>
					connect page
				</a>
				.
			</p>
		</section>
	)
}

export function renderStatusCallout(input: {
	statusTone: ConnectOauthStatusTone
	statusMessage: string
	currentStep: ConnectOauthStep
}) {
	if (input.statusTone === 'error') {
		return (
			<div
				role="alert"
				mix={css(
					getAccentCalloutCss({
						accentColor: colors.error,
					}),
				)}
			>
				<p mix={css({ margin: 0, color: colors.error })}>
					{input.statusMessage}
				</p>
			</div>
		)
	}
	if (input.currentStep === 'callback') {
		return <p mix={css(pageDescriptionCss)}>{input.statusMessage}</p>
	}
	return null
}

export function connectOauthHeaderTitle(input: {
	config: ConnectOauthConfig | null
	requestedProvider: string | null
	statusTone: ConnectOauthStatusTone
	href: string
}) {
	if (input.config) return `Connect ${input.config.provider}`
	if (input.requestedProvider) return `Connect ${input.requestedProvider}`
	if (
		input.statusTone !== 'error' &&
		isConnectOauthCallbackUrl(new URL(input.href, 'https://kody.local'))
	) {
		return 'Completing connection'
	}
	return 'Connect an account'
}

export function connectOauthHeaderDescription(input: {
	config: ConnectOauthConfig | null
	requestedProvider: string | null
	hasConfigError: boolean
	statusTone: ConnectOauthStatusTone
	statusMessage: string
	currentStep: ConnectOauthStep
	href: string
}) {
	if (input.statusTone === 'error') return null
	if (input.currentStep === 'callback') return null
	if (
		!input.config &&
		isConnectOauthCallbackUrl(new URL(input.href, 'https://kody.local'))
	) {
		return null
	}
	if (!input.config) {
		if (input.requestedProvider && input.hasConfigError) {
			return 'This URL is missing the provider endpoints needed to start OAuth.'
		}
		if (!input.requestedProvider) {
			return 'Choose one of your saved integrations.'
		}
		return input.statusMessage
	}
	if (input.currentStep === 'success') return "You're connected."
	if (input.currentStep === 'setup') {
		return `Create an OAuth app on ${input.config.provider}, register the redirect URL, and paste the credentials below.`
	}
	return `Continue to ${input.config.provider} to approve access.`
}
