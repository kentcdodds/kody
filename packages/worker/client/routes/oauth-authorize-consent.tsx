import { css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { PasswordRevealInput } from '#client/password-reveal-input.tsx'
import { renderHoneypot } from '#client/honeypot-field.tsx'
import { turnstileWidgetClassName } from '#client/public-form-protection.ts'
import { renderOauthAuthorizeSignInMethods } from '#client/routes/oauth-authorize-sign-in.tsx'
import { type AuthProviderInfo } from '#client/social-sign-in.ts'
import {
	oauthAuthorizeDangerButtonCss,
	oauthAuthorizePrimaryButtonCss,
	oauthAuthorizeSecondaryButtonCss,
} from '#client/routes/oauth-authorize-chrome.ts'
import {
	oauthAuthorizeApproveAriaLabel,
	oauthAuthorizeConsentDecision,
	oauthAuthorizeEmailVerificationDenyDisabled,
	type OAuthAuthorizeConsentOrg,
} from '#client/routes/oauth-authorize-form.ts'
import { renderAuthorizeOrgField } from '#client/routes/oauth-authorize-org-picker.tsx'
import { spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getAlertCardCss,
	inputCss,
	sectionTitleCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

type OAuthAuthorizeMessage = { type: 'error' | 'info'; text: string }

export function renderOauthAuthorizeConsent(input: {
	needsEmailVerification: boolean
	resetCompleted: boolean
	hydrated: boolean
	submittingDecision: string | null
	sessionLoading: boolean
	message: OAuthAuthorizeMessage | null
	showResetClientCard: boolean
	isLoggedIn: boolean
	isSessionReady: boolean
	resetClientDisabled: boolean
	resetClientLabel: string
	showAuthorizeForm: boolean
	consentForm: { method: string; action: string }
	formReady: boolean
	orgs: ReadonlyArray<OAuthAuthorizeConsentOrg>
	displayedOrgSlug: string | null
	onSelectedOrgSlugChange: (slug: string | null) => void
	onSubmit: (event: SubmitEvent) => void
	onDecision: (decision: 'deny' | 'reset-client') => void
	actionsDisabled: boolean
	signInSubmitting: boolean
	turnstileSiteKey: string | null | undefined
	authProviders: ReadonlyArray<AuthProviderInfo>
	resumeTarget: string | null
	onProviderClick: (providerId: string) => void
	onPasskeyClick: () => void
	approveAriaLabel: string | undefined
	authorizeLabel: string
}) {
	const signInBusy = input.actionsDisabled || input.signInSubmitting
	return (
		<>
			{input.needsEmailVerification && !input.resetCompleted ? (
				<div mix={css({ marginBottom: spacing.md })}>
					<button
						type="button"
						data-testid="oauth-authorize-email-verify-deny"
						disabled={oauthAuthorizeEmailVerificationDenyDisabled({
							hydrated: input.hydrated,
							submitting: Boolean(input.submittingDecision),
							sessionLoading: input.sessionLoading,
						})}
						aria-label={oauthAuthorizeApproveAriaLabel({
							hydrated: input.hydrated,
							label: 'Deny',
						})}
						mix={[
							on('click', () => input.onDecision('deny')),
							css(oauthAuthorizeSecondaryButtonCss),
						]}
					>
						Deny
					</button>
				</div>
			) : null}
			{input.message ? (
				<p
					role={input.message.type === 'error' ? 'alert' : undefined}
					mix={css(getAlertCardCss(input.message.type))}
				>
					{input.message.text}
				</p>
			) : null}
			{input.showResetClientCard ? (
				<section mix={css(cardCss)}>
					<p mix={css(sectionTitleCss)}>Reset stored connection</p>
					<p mix={css(descriptionCss)}>
						Revoke this account&apos;s grants for the client, then start the
						connection again. Shared client registrations used by other accounts
						stay in place.
					</p>
					{input.isLoggedIn ? (
						<button
							type="button"
							disabled={input.resetClientDisabled}
							mix={[
								on('click', () => input.onDecision('reset-client')),
								css(oauthAuthorizeDangerButtonCss),
							]}
						>
							{input.resetClientLabel}
						</button>
					) : input.isSessionReady ? (
						<p mix={css(descriptionCss)}>
							Sign in first, then reset this connection.
						</p>
					) : null}
				</section>
			) : null}
			{input.showAuthorizeForm ? (
				<form
					method={input.consentForm.method}
					action={input.consentForm.action}
					data-testid="oauth-authorize-form"
					aria-busy={input.hydrated ? undefined : 'true'}
					mix={[
						css({
							...cardCss,
							opacity: input.formReady ? 1 : 0.7,
						}),
						on('submit', input.onSubmit),
					]}
				>
					{input.hydrated ? null : (
						<p role="status" mix={css(visuallyHiddenCss)}>
							Connection approval is available after the page finishes loading.
						</p>
					)}
					<input
						type="hidden"
						name="decision"
						value={oauthAuthorizeConsentDecision}
					/>
					{renderAuthorizeOrgField({
						orgs: input.orgs,
						selectedOrgSlug: input.displayedOrgSlug,
						signedIn: input.isLoggedIn,
						onSelectedOrgSlugChange: input.onSelectedOrgSlugChange,
					})}
					{renderHoneypot()}
					{!input.isLoggedIn && input.isSessionReady ? (
						<>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Email</span>
								<input
									type="email"
									name="email"
									required
									autoComplete="email"
									placeholder="you@example.com"
									disabled={signInBusy}
									mix={css(inputCss)}
								/>
							</label>
							<div mix={css(fieldCss)}>
								<label for="oauth-authorize-password" mix={css(fieldLabelCss)}>
									Password
								</label>
								<PasswordRevealInput
									id="oauth-authorize-password"
									name="password"
									required
									autoComplete="current-password"
									placeholder="Enter your password"
									disabled={signInBusy}
									mix={css(inputCss)}
								/>
							</div>
						</>
					) : null}
					{!input.isLoggedIn && input.turnstileSiteKey ? (
						<div class={turnstileWidgetClassName}></div>
					) : null}
					<div
						mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}
					>
						<button
							type="submit"
							data-testid="oauth-authorize-approve"
							disabled={signInBusy}
							aria-label={input.approveAriaLabel}
							mix={css(oauthAuthorizePrimaryButtonCss)}
						>
							{input.authorizeLabel}
						</button>
						<button
							type="button"
							disabled={signInBusy}
							aria-label={oauthAuthorizeApproveAriaLabel({
								hydrated: input.hydrated,
								label: 'Deny',
							})}
							mix={[
								on('click', () => input.onDecision('deny')),
								css(oauthAuthorizeSecondaryButtonCss),
							]}
						>
							Deny
						</button>
					</div>
					{!input.isLoggedIn && input.isSessionReady
						? renderOauthAuthorizeSignInMethods({
								providers: input.authProviders,
								disabled: signInBusy,
								// /login bounces existing sessions straight back. With
								// prompt=login that loops, so only link when unsigned.
								resumeTarget: input.resumeTarget,
								onProviderClick: input.onProviderClick,
								onPasskeyClick: input.onPasskeyClick,
							})
						: null}
				</form>
			) : null}
		</>
	)
}
