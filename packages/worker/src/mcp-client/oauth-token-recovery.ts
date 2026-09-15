import {
	buildMcpServerLastError,
	sanitizePublicUrl,
} from './oauth-settle-error.ts'
import { type McpServerLastError } from './types.ts'

export const mcpOAuthTokenRecoveryStoragePrefix = 'mcp-oauth-token-recovery/'

export type McpOAuthTokenPresence = {
	hasAccessToken: boolean
	hasRefreshToken: boolean
}

export function mcpOAuthTokenRecoveryStorageKey(serverId: string) {
	return `${mcpOAuthTokenRecoveryStoragePrefix}${serverId}`
}

export function readMcpOAuthTokenPresence(
	tokens: unknown,
): McpOAuthTokenPresence {
	if (!tokens || typeof tokens !== 'object') {
		return { hasAccessToken: false, hasRefreshToken: false }
	}
	const record = tokens as Record<string, unknown>
	return {
		hasAccessToken:
			typeof record['access_token'] === 'string' &&
			record['access_token'].trim().length > 0,
		hasRefreshToken:
			typeof record['refresh_token'] === 'string' &&
			record['refresh_token'].trim().length > 0,
	}
}

/**
 * Authorization servers often omit `refresh_token` on refresh (and
 * sometimes on a second authorization-code grant). RFC 6749 says the
 * client must keep the existing refresh token in that case. The Agents
 * SDK `saveTokens` replaces the whole blob, so a merge has to happen
 * before the write.
 */
export function mergeMcpOAuthTokens(input: {
	incoming: unknown
	existing: unknown
}): unknown {
	if (!input.incoming || typeof input.incoming !== 'object') {
		return input.incoming
	}
	const incomingPresence = readMcpOAuthTokenPresence(input.incoming)
	if (incomingPresence.hasRefreshToken) return input.incoming
	const existingPresence = readMcpOAuthTokenPresence(input.existing)
	if (!existingPresence.hasRefreshToken) return input.incoming
	if (!input.existing || typeof input.existing !== 'object') {
		return input.incoming
	}
	return {
		...(input.incoming as Record<string, unknown>),
		refresh_token: (input.existing as Record<string, unknown>)['refresh_token'],
	}
}

export function shouldAttemptMcpOAuthRefresh(presence: McpOAuthTokenPresence) {
	return presence.hasAccessToken || presence.hasRefreshToken
}

/**
 * Queue `mcp.server.disconnected` for a durable token-recovery park.
 * A stale access token with no refresh token is the "Authorization
 * required / no refresh token / phase token exchange" card — still a
 * working → failed flip even when episode `wasReady` was never written.
 */
export function shouldQueueMcpTokenRecoveryDisconnected(input: {
	wasReady: boolean
	presence: McpOAuthTokenPresence
	hasTokenRecoveryLastError: boolean
}) {
	return (
		input.wasReady ||
		shouldAttemptMcpOAuthRefresh(input.presence) ||
		input.hasTokenRecoveryLastError
	)
}

export function describeMcpOAuthTokenRecovery(input: {
	hadRefreshToken: boolean
	stillHasRefreshToken: boolean
}): string {
	if (input.hadRefreshToken && !input.stillHasRefreshToken) {
		return 'Stored OAuth tokens could not be refreshed. The authorization server rejected or consumed the refresh token, so Kody discarded it and needs a new authorization'
	}
	if (input.hadRefreshToken) {
		return 'Stored OAuth tokens could not keep this MCP server ready. Refresh did not restore the connection, so Kody started a new authorization'
	}
	return "This MCP server's stored access token is no longer usable and Kody has no refresh token to renew it"
}

export function isMcpOAuthTokenRecoveryLastError(
	lastError: McpServerLastError | null,
): boolean {
	if (!lastError || lastError.phase !== 'token exchange') return false
	const message = lastError.message.toLowerCase()
	return (
		message.includes('could not be refreshed') ||
		message.includes('could not keep this mcp server ready') ||
		message.includes('has no refresh token to renew')
	)
}

export function buildMcpOAuthTokenRecoveryLastError(input: {
	authUrl: string | null
	mcpEndpoint?: string | null
	hadRefreshToken: boolean
	stillHasRefreshToken: boolean
	attemptId?: string | null
	at?: string
}): McpServerLastError {
	const reason = describeMcpOAuthTokenRecovery({
		hadRefreshToken: input.hadRefreshToken,
		stillHasRefreshToken: input.stillHasRefreshToken,
	})
	return buildMcpServerLastError({
		state: 'authenticating',
		authUrl: input.authUrl,
		error: reason,
		phase: 'token exchange',
		mcpEndpoint: sanitizePublicUrl(input.mcpEndpoint),
		attemptId: input.attemptId?.trim() || crypto.randomUUID(),
		at: input.at,
	})
}
