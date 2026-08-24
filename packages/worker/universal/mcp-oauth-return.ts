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
