/**
 * Social-login failure codes carried back to `/login?oauthError=<code>`.
 * Shared with the client login route, which maps codes to friendly copy, so
 * no free-form text travels through the redirect URL.
 */
export const oauthLoginErrorMessages = {
	'unknown-provider': 'That sign-in provider is not supported.',
	'not-configured': 'This sign-in provider is not configured yet.',
	'state-mismatch':
		'Your sign-in session expired or did not match. Please try again.',
	denied: 'Sign-in was cancelled.',
	'provider-error':
		'We could not complete sign-in with the provider. Please try again.',
	'no-verified-email':
		'The provider did not share a verified email for your account. Sign in another way first, then connect the provider from this screen while signed in.',
	'invite-required':
		'New accounts need an invite code. Open Sign up, enter your invite, then continue with this provider.',
	'invite-invalid': 'That invite code is invalid.',
	'invite-revoked': 'That invite code has been revoked.',
	'invite-expired': 'That invite code has expired.',
	'invite-exhausted': 'That invite code has already been used.',
	'connection-conflict':
		'That provider account is already connected to a different user.',
	'account-error': 'We could not create your account. Please try again.',
	'rate-limited': 'Too many sign-in attempts. Please try again later.',
} as const

export type OauthLoginErrorCode = keyof typeof oauthLoginErrorMessages

export function getOauthLoginErrorMessage(code: string | null) {
	if (!code) return null
	if (code in oauthLoginErrorMessages) {
		return oauthLoginErrorMessages[code as OauthLoginErrorCode]
	}
	return oauthLoginErrorMessages['provider-error']
}
