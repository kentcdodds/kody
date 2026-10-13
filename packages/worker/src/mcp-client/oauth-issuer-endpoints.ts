/**
 * Mix-up defence (kentcdodds/kody#3284, parity with kody-celld#60 / #53): the
 * authorization and token endpoints must be on the issuer's origin. Every public
 * MCP authorization server surveyed (Linear, Notion, Atlassian, Sentry, Asana,
 * Canva, Zapier, PayPal, Supabase, GitHub) and Home Assistant keep both there.
 * `registration_endpoint` is out of scope.
 */

export type McpOAuthDiscoveryForIssuerEndpoints = {
	authorizationServerMetadata?: unknown
}

export const mcpOAuthFailedCode = 'mcp_oauth_failed'

export class McpOAuthFailedError extends Error {
	readonly code = mcpOAuthFailedCode
	readonly status = 502

	constructor(message: string) {
		super(`${mcpOAuthFailedCode}: ${message}`)
		this.name = 'McpOAuthFailedError'
	}
}

export function assertEndpointsOnIssuerOrigin(
	discovery: McpOAuthDiscoveryForIssuerEndpoints,
) {
	const metadata = discovery.authorizationServerMetadata
	if (!metadata || typeof metadata !== 'object') return
	const record = metadata as Record<string, unknown>
	const issuer = record['issuer']
	if (typeof issuer !== 'string' || !issuer) {
		throw new McpOAuthFailedError(
			'Authorization server metadata is missing a usable issuer.',
		)
	}

	let issuerUrl: URL
	try {
		issuerUrl = new URL(issuer)
	} catch {
		throw new McpOAuthFailedError(
			`Authorization server issuer (${issuer.slice(0, 200)}) is not a valid URL.`,
		)
	}
	if (issuerUrl.protocol !== 'https:') {
		throw new McpOAuthFailedError(
			`Authorization server issuer must use https (got ${issuerUrl.protocol}).`,
		)
	}
	const issuerOrigin = issuerUrl.origin

	for (const field of ['authorization_endpoint', 'token_endpoint'] as const) {
		const value = record[field]
		if (typeof value !== 'string' || !value) continue
		let endpointUrl: URL | null = null
		try {
			endpointUrl = new URL(value)
		} catch {
			/* refused below */
		}
		if (
			endpointUrl == null ||
			endpointUrl.protocol !== 'https:' ||
			endpointUrl.origin !== issuerOrigin
		) {
			throw new McpOAuthFailedError(
				`Authorization server ${field} (${endpointUrl?.origin ?? value.slice(0, 200)}) is on a different origin than its issuer (${issuerOrigin}).`,
			)
		}
	}
}
