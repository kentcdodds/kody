/**
 * Onboarding MCP authorize opens a popup and sets this cookie so the OAuth
 * callback can send that tab back to the wizard instead of the account
 * MCP-servers detail page.
 */
export const mcpOAuthReturnCookieName = 'kody_mcp_oauth_return'
export const mcpOAuthReturnOnboarding = 'onboarding'
export const mcpOAuthMessageType = 'kody-mcp-oauth-done'
export const mcpOAuthPopupName = 'kody-mcp-oauth'
export const mcpOAuthChannelName = 'kody-mcp-oauth'

export type McpOAuthDoneMessage = {
	type: typeof mcpOAuthMessageType
	auth: string | null
	reason: string | null
	server: string | null
}

export function readMcpOAuthDoneMessage(
	data: unknown,
): McpOAuthDoneMessage | null {
	if (!data || typeof data !== 'object') return null
	const record = data as Record<string, unknown>
	if (record.type !== mcpOAuthMessageType) return null
	return {
		type: mcpOAuthMessageType,
		auth: typeof record.auth === 'string' ? record.auth : null,
		reason: typeof record.reason === 'string' ? record.reason : null,
		server: typeof record.server === 'string' ? record.server : null,
	}
}

export function readMcpOAuthReturnCookie(
	cookieHeader: string | null,
): typeof mcpOAuthReturnOnboarding | null {
	if (!cookieHeader) return null
	for (const part of cookieHeader.split(';')) {
		const trimmed = part.trim()
		const separator = trimmed.indexOf('=')
		if (separator <= 0) continue
		const name = trimmed.slice(0, separator)
		const value = trimmed.slice(separator + 1)
		if (
			name === mcpOAuthReturnCookieName &&
			value === mcpOAuthReturnOnboarding
		) {
			return mcpOAuthReturnOnboarding
		}
	}
	return null
}

export function mcpOAuthReturnCookie(input: {
	value: typeof mcpOAuthReturnOnboarding | ''
	secure: boolean
}): string {
	const maxAge = input.value ? 1800 : 0
	const secure = input.secure ? '; Secure' : ''
	return `${mcpOAuthReturnCookieName}=${input.value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`
}
