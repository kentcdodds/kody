import { startAuthentication } from '@simplewebauthn/browser'
import { css } from 'remix/component'
import { on } from '#client/event-mixin.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	emptyPublicFormProtection,
	readPublicFormProtection,
} from '#client/public-form-protection.ts'
import { resolvePasswordAuthRedirect } from '#client/routes/resolve-password-auth-redirect.ts'
import { renderSocialSignInButtons } from '#client/routes/social-sign-in-buttons.tsx'
import {
	startSocialSignIn,
	type AuthProviderInfo,
} from '#client/social-sign-in.ts'
import { renderIcon } from '#universal/icon.tsx'
import { spacing } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'

function readOauthAuthorizeFormProtection() {
	const authForm = document.querySelector<HTMLFormElement>(
		'form[data-testid="oauth-authorize-form"]',
	)
	return authForm
		? readPublicFormProtection(new FormData(authForm), authForm)
		: emptyPublicFormProtection()
}

/**
 * Shared with `/login`: social start + passkey verification, then resume the
 * authorize URL (post-auth landing strips `prompt=login`).
 */
export async function startOauthAuthorizeProviderSignIn(input: {
	providerId: string
	redirectTo: string | null
}): Promise<string | null> {
	return startSocialSignIn(
		input.providerId,
		input.redirectTo,
		readOauthAuthorizeFormProtection(),
	)
}

export async function startOauthAuthorizePasskeySignIn(input: {
	redirectTo: string | null
}): Promise<{ ok: true } | { ok: false; error: string | null }> {
	const optionsResponse = await fetch('/webauthn/authentication', {
		headers: { Accept: 'application/json' },
		credentials: 'include',
	})
	const optionsPayload = await optionsResponse.json().catch(() => null)
	if (
		!optionsResponse.ok ||
		optionsPayload?.ok !== true ||
		!optionsPayload.options
	) {
		return { ok: false, error: 'Unable to start passkey sign-in.' }
	}

	let authenticationResponse
	try {
		authenticationResponse = await startAuthentication({
			optionsJSON: optionsPayload.options,
		})
	} catch {
		return { ok: false, error: null }
	}

	const protection = readOauthAuthorizeFormProtection()
	const verificationResponse = await fetch('/webauthn/authentication', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({
			response: authenticationResponse,
			rememberMe: false,
			...protection,
		}),
	})
	const verificationPayload = await verificationResponse
		.json()
		.catch(() => null)
	if (!verificationResponse.ok || verificationPayload?.ok !== true) {
		const errorMessage =
			typeof verificationPayload?.error === 'string'
				? verificationPayload.error
				: 'Passkey sign-in failed.'
		return { ok: false, error: errorMessage }
	}

	window.location.assign(
		resolvePasswordAuthRedirect({
			mode: 'login',
			requiresTwoFactor: verificationPayload.requiresTwoFactor === true,
			redirectTo: input.redirectTo,
		}),
	)
	return { ok: true }
}

export function renderOauthAuthorizeSignInMethods(input: {
	providers: ReadonlyArray<AuthProviderInfo>
	disabled: boolean
	/** When null, omit the /login escape hatch (avoids prompt=login bounce). */
	resumeTarget: string | null
	onProviderClick: (providerId: string) => void
	onPasskeyClick: () => void
}) {
	return (
		<>
			{renderSocialSignInButtons({
				providers: input.providers,
				disabled: input.disabled,
				onProviderClick: input.onProviderClick,
			})}
			<button
				type="button"
				disabled={input.disabled}
				data-testid="oauth-authorize-passkey"
				mix={[
					css(passkeyButtonCss),
					on('click', () => {
						input.onPasskeyClick()
					}),
				]}
			>
				{renderIcon('key', { size: '17' })}
				Sign in with a passkey
			</button>
			{input.resumeTarget ? (
				<p mix={css(descriptionCss)}>
					<a
						href={buildAuthLink('/login', input.resumeTarget)}
						mix={css(mutedLinkCss)}
					>
						Use the full sign-in page
					</a>
				</p>
			) : null}
		</>
	)
}

const passkeyButtonCss = {
	...getGhostButtonCss(),
	width: '100%',
	justifyContent: 'center',
	gap: spacing.sm,
	marginTop: spacing.sm,
}
