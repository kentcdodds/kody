import { type SignupMode } from '#app/signup-mode.ts'

export type AuthProviderInfo = { id: string; label: string }
export type PublicAuthConfig = {
	providers: Array<AuthProviderInfo>
	signupMode: SignupMode
	turnstileSiteKey: string | null
}

export function buildProviderStartPath(
	providerId: string,
	redirectTo: string | null,
	inviteCode: string | null = null,
) {
	const params = new URLSearchParams()
	if (redirectTo) params.set('redirectTo', redirectTo)
	const trimmedInvite = inviteCode?.trim()
	if (trimmedInvite) params.set('inviteCode', trimmedInvite)
	const query = params.toString()
	return query ? `/auth/${providerId}?${query}` : `/auth/${providerId}`
}

/**
 * Returns the enabled providers, or null when the request failed — callers
 * must not treat a transient failure as "no providers configured".
 */
export async function fetchEnabledAuthProviders(
	signal?: AbortSignal,
): Promise<Array<AuthProviderInfo> | null> {
	const config = await fetchPublicAuthConfig(signal)
	return config?.providers ?? null
}

export async function fetchPublicAuthConfig(
	signal?: AbortSignal,
): Promise<PublicAuthConfig | null> {
	try {
		const response = await fetch('/auth/providers.json', {
			headers: { Accept: 'application/json' },
			signal,
		})
		const payload = await response.json().catch(() => null)
		if (!response.ok || payload?.ok !== true) return null
		const providers = (
			Array.isArray(payload.providers) ? payload.providers : []
		).filter(
			(provider: unknown): provider is AuthProviderInfo =>
				typeof provider === 'object' &&
				provider !== null &&
				typeof (provider as AuthProviderInfo).id === 'string' &&
				typeof (provider as AuthProviderInfo).label === 'string',
		)
		const signupMode: SignupMode =
			payload.signupMode === 'open' || payload.signupMode === 'waitlist'
				? payload.signupMode
				: 'invite'
		const turnstileSiteKey =
			typeof payload.turnstileSiteKey === 'string'
				? payload.turnstileSiteKey
				: null
		return { providers, signupMode, turnstileSiteKey }
	} catch {
		return null
	}
}

/**
 * Start a social sign-in or account connection: fetch the authorize URL from
 * the start endpoint and navigate to it at the top level. The CSP locks
 * `form-action` and `connect-src` to 'self', so neither a form-POST redirect
 * nor a fetch-followed redirect may leave the origin — a top-level JS
 * navigation may. Returns an error message, or null when navigation started.
 *
 * Pass `inviteCode` when starting from the invite signup panel so production
 * can create the account on callback.
 */
export async function startSocialSignIn(
	providerId: string,
	redirectTo: string | null,
	inviteCode: string | null = null,
	protection: { website: string; turnstileToken: string } = {
		website: '',
		turnstileToken: '',
	},
): Promise<string | null> {
	const response = await fetch(
		buildProviderStartPath(providerId, redirectTo, inviteCode),
		{
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify(protection),
		},
	)
	const payload = await response.json().catch(() => null)
	if (
		!response.ok ||
		payload?.ok !== true ||
		typeof payload.authorizeUrl !== 'string'
	) {
		return typeof payload?.error === 'string'
			? payload.error
			: 'Unable to start sign-in. Please try again.'
	}
	window.location.assign(payload.authorizeUrl)
	return null
}
