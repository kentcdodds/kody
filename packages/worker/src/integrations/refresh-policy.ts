/**
 * Whether a connection's sign-in is expected to be renewed with a refresh
 * token. Inferred from the provider token response on every `/connect/oauth`
 * persist (reconnect overwrites it) — never from app or provider defaults.
 *
 * - `required`: the provider issued a refresh token or an expiring access
 *   token, so a missing refresh token later is a real reconnect case.
 * - `not_applicable`: neither was issued (for example GitHub OAuth Apps with
 *   token expiration off). The access token does not expire, so there is
 *   nothing to refresh and no refresh token is healthy.
 *
 * `null` on a stored connection means unknown (config saved before any token
 * persist); refresh treats it like `required`.
 */
export const integrationRefreshPolicies = [
	'required',
	'not_applicable',
] as const

export type IntegrationRefreshPolicy =
	(typeof integrationRefreshPolicies)[number]

export function isIntegrationRefreshPolicy(
	value: unknown,
): value is IntegrationRefreshPolicy {
	return (
		typeof value === 'string' &&
		(integrationRefreshPolicies as ReadonlyArray<string>).includes(value)
	)
}

export function inferIntegrationRefreshPolicy(
	tokenPayload: Record<string, unknown>,
): IntegrationRefreshPolicy {
	const refreshToken = tokenPayload.refresh_token
	if (typeof refreshToken === 'string' && refreshToken.trim()) {
		return 'required'
	}
	if (
		hasAccessTokenExpiry(tokenPayload.expires_in) ||
		hasAccessTokenExpiry(tokenPayload.expires_at)
	) {
		return 'required'
	}
	return 'not_applicable'
}

function hasAccessTokenExpiry(value: unknown) {
	if (typeof value === 'number') return Number.isFinite(value) && value > 0
	if (typeof value !== 'string') return false
	const trimmed = value.trim()
	if (!trimmed) return false
	const numeric = Number(trimmed)
	if (Number.isFinite(numeric)) return numeric > 0
	return !Number.isNaN(Date.parse(trimmed))
}
