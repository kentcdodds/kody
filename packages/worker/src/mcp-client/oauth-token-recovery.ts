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

export function shouldAttemptMcpOAuthRefresh(presence: McpOAuthTokenPresence) {
	return presence.hasAccessToken || presence.hasRefreshToken
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
): lastError is McpServerLastError {
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
