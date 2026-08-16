import {
	type McpServerConnectionState,
	type McpServerOAuthCallbackOutcome,
} from './types.ts'

/**
 * Decide the user-facing OAuth callback outcome from the Agents SDK result
 * plus the post-establish connection snapshot.
 *
 * The SDK's `authSuccess` only means the authorization code was accepted (or
 * treated as already accepted). Kody must not report success until the MCP
 * connection is actually `ready`. Otherwise users can land on
 * "Authorization required" with no auth URL and no error — the Clerk / Convex
 * MCP failure mode reported by Bernardo.
 */
export function resolveMcpOAuthCallbackOutcome(input: {
	sdkAuthSuccess: boolean
	sdkAuthError: string | null
	serverId: string | null
	serverName: string | null
	connection: {
		state: McpServerConnectionState
		authUrl: string | null
		error: string | null
	} | null
}): McpServerOAuthCallbackOutcome {
	const { serverId, serverName } = input

	if (!input.sdkAuthSuccess || !serverId) {
		return {
			serverId,
			authSuccess: false,
			authError: input.sdkAuthError ?? 'Authorization failed.',
			serverName,
			authorizationNeeded: false,
		}
	}

	if (!input.connection) {
		return {
			serverId,
			authSuccess: false,
			authError:
				'Authorization completed, but Kody lost the MCP server connection. Try reconnecting from /account/mcp-servers.',
			serverName,
			authorizationNeeded: false,
		}
	}

	if (input.connection.state === 'ready') {
		return {
			serverId,
			authSuccess: true,
			authError: null,
			serverName,
			authorizationNeeded: false,
		}
	}

	return {
		serverId,
		authSuccess: false,
		authError:
			input.connection.error ??
			describeIncompleteMcpOAuthConnection(input.connection),
		serverName,
		authorizationNeeded: false,
	}
}

export function describeIncompleteMcpOAuthConnection(connection: {
	state: McpServerConnectionState
	authUrl: string | null
}): string {
	if (connection.state === 'authenticating' && connection.authUrl) {
		return 'Authorization completed at the identity provider, but the MCP server still requires authorization. Open the authorization link again from /account/mcp-servers.'
	}
	if (connection.state === 'authenticating') {
		return 'Authorization completed, but Kody could not finish connecting. Reconnect the server from /account/mcp-servers and approve access once more.'
	}
	return `Authorization completed at the identity provider, but the MCP server is still "${connection.state}". Reconnect it from /account/mcp-servers.`
}

/**
 * Agents SDK quirk: `connectToServer` can leave `connectionState` as
 * `authenticating` while returning FAILED when `authUrl` is missing, and
 * `oauthCallbackSuccess` clears the stored auth URL. Detect that stuck state
 * so callers can recover before surfacing success/error to the user.
 */
export function isStuckMcpAuthenticatingWithoutAuthUrl(connection: {
	state: McpServerConnectionState
	authUrl: string | null
}): boolean {
	return connection.state === 'authenticating' && !connection.authUrl
}
