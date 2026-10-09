import { type RouteLoaderResult } from '#client/route-loader.ts'
import {
	readOAuthAuthorizeConsentOrgs,
	readOAuthAuthorizeSelectedOrgSlug,
} from '#client/routes/oauth-authorize-form.ts'
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'

export async function oauthAuthorizeRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const [response, authConfig] = await Promise.all([
		fetch(`/oauth/authorize-info${url.search}`, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		}),
		fetchPublicAuthConfig(signal),
	])
	const payload = await response.json().catch(() => null)
	const authProvidersPayload = authConfig
		? {
				authProviders: {
					ok: true as const,
					providers: authConfig.providers,
					turnstileSiteKey: authConfig.turnstileSiteKey,
				},
			}
		: {}
	if (!response.ok || !payload?.ok) {
		const errorText =
			typeof payload?.error === 'string'
				? payload.error
				: 'Unable to load authorization details.'
		return {
			...authProvidersPayload,
			oauthAuthorize: {
				ok: false,
				error: errorText,
				allowClientReset: payload?.allowClientReset === true,
				code: typeof payload?.code === 'string' ? payload.code : undefined,
			},
		}
	}
	return {
		...authProvidersPayload,
		oauthAuthorize: {
			ok: true,
			client: payload.client,
			scopes: payload.scopes,
			emailVerified:
				typeof payload.emailVerified === 'boolean'
					? payload.emailVerified
					: null,
			requireCredentials: payload.requireCredentials === true,
			orgs: readOAuthAuthorizeConsentOrgs(payload.orgs),
			selectedOrgSlug: readOAuthAuthorizeSelectedOrgSlug(
				payload.selectedOrgSlug,
			),
		},
	}
}
