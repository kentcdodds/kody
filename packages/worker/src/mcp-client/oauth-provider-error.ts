/**
 * Turn opaque third-party OAuth/AS errors into actionable guidance when Kody
 * is the MCP *client* (user-added servers).
 *
 * Providers such as FusionAuth reject authorize requests whose browser
 * Origin/Referer is not on an authorized-origins allowlist, producing messages
 * like `Invalid origin uri https://kody.codes`. Redirect-URI mismatches are a
 * related class. Both are configured on the remote authorization server, not
 * in Kody.
 */
export function enrichMcpOAuthProviderError(
	message: string,
	input: { callbackUrl: string; clientOrigin: string },
): string {
	const trimmed = message.trim()
	if (!trimmed) return trimmed

	const lower = trimmed.toLowerCase()
	const looksLikeOriginRejection =
		lower.includes('invalid origin') ||
		lower.includes('unauthorized origin') ||
		lower.includes('origin uri') ||
		lower.includes('authorized origin')
	const looksLikeRedirectRejection =
		lower.includes('invalid redirect') ||
		lower.includes('redirect_uri') ||
		lower.includes('redirect uri')

	if (!looksLikeOriginRejection && !looksLikeRedirectRejection) {
		return trimmed
	}

	const parts = [
		trimmed,
		`Kody authorizes as an OAuth client from ${input.clientOrigin}.`,
		`If you operate this MCP server (or its identity provider), allow that origin and register this exact redirect URI: ${input.callbackUrl}.`,
		'Then reconnect the server in Kody so authorization uses the allowlisted values.',
	]
	return parts.join(' ')
}
