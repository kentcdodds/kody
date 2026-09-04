/**
 * OIDC identity scopes advertised by Kody's MCP authorization server.
 * MCP access is one grant (not a permission menu); see
 * docs/contributing/decisions/0049-no-mcp-capability-oauth-scopes.md.
 */
export const mcpOauthScopes: Array<string> = ['openid', 'profile', 'email']
