import { getAppBaseUrl } from '#worker/app-base-url.ts'

/**
 * RFC 9207 `iss` on an authorization response (success or error) sent to the
 * client's `redirect_uri`. The value must match the discovery issuer
 * (`getAppBaseUrl` / `/.well-known/openid-configuration` and
 * `/.well-known/oauth-authorization-server`).
 *
 * `@cloudflare/workers-oauth-provider` advertises
 * `authorization_response_iss_parameter_supported: true` and adds `iss` on
 * success only when `AuthRequest.issuer` is set. Hand-rolled client redirects
 * never went through that helper. Stamp every outbound client redirect here so
 * a missing provider field cannot omit `iss`.
 */
export function withAuthorizationResponseIssuer(
	redirectTo: string,
	issuer: string,
) {
	const redirectUrl = new URL(redirectTo)
	redirectUrl.searchParams.set('iss', issuer)
	return redirectUrl.toString()
}

export function stampAuthorizationResponseIssuer(
	redirectTo: string,
	input: {
		env: Parameters<typeof getAppBaseUrl>[0]['env']
		requestUrl: string | URL
	},
) {
	return withAuthorizationResponseIssuer(
		redirectTo,
		getAppBaseUrl({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
	)
}
