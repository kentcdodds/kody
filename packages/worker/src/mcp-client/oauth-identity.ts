import {
	assertEndpointsOnIssuerOrigin,
	type McpOAuthDiscoveryForIssuerEndpoints,
} from './oauth-issuer-endpoints.ts'

/**
 * Pending MCP OAuth attempts are bound to the server row id and OAuth client
 * id they started with (kody-celld #50, #55 / #57 / #65). One predicate is used
 * at callback start and again immediately before persisting the grant so those
 * two moments cannot drift apart. Hosted also stamps owner org + person.
 *
 * Client identity is the OAuth client **id** only: rotating a secret for the
 * same client id is not an identity change.
 */

export { assertEndpointsOnIssuerOrigin }

export function oauthAttemptIdentityMatches(input: {
	pendingServerId: string | null | undefined
	pendingClientId: string | null | undefined
	serverId: string | null | undefined
	clientId: string | null | undefined
}): boolean {
	return Boolean(
		input.pendingServerId &&
		input.serverId === input.pendingServerId &&
		input.pendingClientId &&
		input.clientId === input.pendingClientId,
	)
}

/** Owner org + initiating/consenting person stamped on the pending attempt. */
export function oauthAttemptActorMatches(input: {
	pendingOwnerOrgId: string | null | undefined
	pendingPersonId: string | null | undefined
	ownerOrgId: string | null | undefined
	personId: string | null | undefined
}): boolean {
	return Boolean(
		input.pendingOwnerOrgId &&
		input.ownerOrgId === input.pendingOwnerOrgId &&
		input.pendingPersonId &&
		input.personId === input.pendingPersonId,
	)
}

/**
 * Where to send the person after a refused grant write. MCP reconnect still
 * lives on the account MCP servers list (`/connect/credential` is not on main).
 */
export function mcpOAuthAttemptReconnectHref() {
	return '/account/mcp-servers'
}

/** Origin of an MCP server URL, or null when the URL cannot be parsed. */
export function mcpOAuthServerOrigin(serverUrl: string): string | null {
	try {
		return new URL(serverUrl).origin
	} catch {
		return null
	}
}

export function sameMcpOAuthServerUrl(pendingUrl: string, liveUrl: string) {
	return pendingUrl === liveUrl
}

export function sameMcpOAuthServerOrigin(
	pendingOrigin: string,
	liveUrl: string,
) {
	return mcpOAuthServerOrigin(liveUrl) === pendingOrigin
}

/** Issuer / AS origin from stored MCP OAuth discovery, when present. */
export function authorizationServerOriginFromDiscovery(
	discovery: unknown,
): string | null {
	if (!discovery || typeof discovery !== 'object') return null
	const record = discovery as Record<string, unknown>
	const metadata =
		record['authorizationServerMetadata'] &&
		typeof record['authorizationServerMetadata'] === 'object'
			? (record['authorizationServerMetadata'] as Record<string, unknown>)
			: null
	const issuer =
		(typeof metadata?.['issuer'] === 'string' && metadata['issuer']) ||
		(typeof record['authorizationServerUrl'] === 'string' &&
			record['authorizationServerUrl']) ||
		null
	if (!issuer) return null
	return mcpOAuthServerOrigin(issuer)
}

/**
 * Fail-closed copy when the server row, URL/origin, client, actor, or
 * discovered AS origin no longer matches the attempt. Includes a reconnect
 * link so agents and UI can send the person back to start a fresh flow.
 */
export function mcpOAuthAttemptIdentityInvalidMessage(
	serverName?: string | null,
) {
	const label = serverName?.trim() ? ` "${serverName.trim()}"` : ''
	return `MCP server${label} was removed or changed while authorizing; nothing was saved. Reconnect at ${mcpOAuthAttemptReconnectHref()}.`
}

/**
 * True when authorization/token endpoints on discovery still target the AS
 * origin recorded when the attempt started. Missing endpoints are ignored;
 * a missing or unparsable live origin fails closed when a pending origin exists.
 */
export function discoveryMatchesAttemptAuthorizationServerOrigin(input: {
	pendingAuthorizationServerOrigin: string | null | undefined
	discovery: unknown
}): boolean {
	const pending = input.pendingAuthorizationServerOrigin
	if (!pending) return true
	const liveOrigin = authorizationServerOriginFromDiscovery(input.discovery)
	if (!liveOrigin || liveOrigin !== pending) return false
	try {
		assertEndpointsOnIssuerOrigin(
			input.discovery as McpOAuthDiscoveryForIssuerEndpoints,
		)
		return true
	} catch {
		return false
	}
}
