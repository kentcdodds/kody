/** The server id in an MCP OAuth `state` of the form `<nonce>.<serverId>`. */
export function extractMcpServerIdFromOAuthState(state: string | null) {
	if (!state) return null
	const parts = state.split('.')
	if (parts.length !== 2) return null
	return parts[1] || null
}
