export type McpServerRef = {
	serverId: string
	name: string
}

export const mcpServerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** Upper bound for static Authorization header values stored for MCP clients. */
export const mcpServerBearerTokenMaxLength = 8_192

const authorizationSchemePattern = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\s+\S/

export function normalizeMcpServerName(name: string): string {
	return name.trim().toLowerCase()
}

export function isValidMcpServerName(name: string): boolean {
	return mcpServerNamePattern.test(normalizeMcpServerName(name))
}

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Remote MCP servers must be reachable over HTTP(S). Plain HTTP is only
 * allowed for loopback hosts so local development against a mock server works;
 * anything else must use HTTPS. Private/internal addresses are additionally
 * rejected at connect time by the Agents SDK MCP client.
 */
export function validateMcpServerUrl(url: string): {
	ok: boolean
	url?: string
	error?: string
} {
	const trimmed = url.trim()
	if (!trimmed) {
		return { ok: false, error: 'Server URL is required.' }
	}
	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		return { ok: false, error: 'Server URL must be a valid absolute URL.' }
	}
	if (parsed.protocol === 'https:') {
		return { ok: true, url: parsed.toString() }
	}
	if (parsed.protocol === 'http:' && loopbackHostnames.has(parsed.hostname)) {
		return { ok: true, url: parsed.toString() }
	}
	return {
		ok: false,
		error:
			'Server URL must use https (plain http is only allowed for localhost).',
	}
}

/**
 * Normalize an optional static MCP Authorization credential.
 *
 * Empty input means no header. Accepts:
 * - bare tokens → `Bearer <token>`
 * - scheme-prefixed values (`Bearer …`, `token …`) kept as-is
 * - full header pastes (`Authorization: Bearer …`) with the header name stripped
 *
 * The result is suitable for an `Authorization` request header on every MCP
 * client request.
 */
export function normalizeMcpServerBearerToken(
	token: string | null | undefined,
): {
	ok: boolean
	authorization?: string
	error?: string
} {
	if (token == null) {
		return { ok: true }
	}
	let trimmed = token.trim()
	if (!trimmed) {
		return { ok: true }
	}
	const authorizationHeaderPrefix = /^authorization\s*:\s*/i
	if (authorizationHeaderPrefix.test(trimmed)) {
		trimmed = trimmed.replace(authorizationHeaderPrefix, '').trim()
	}
	if (!trimmed) {
		return {
			ok: false,
			error: 'Bearer token is required when Authorization is provided.',
		}
	}
	if (trimmed.length > mcpServerBearerTokenMaxLength) {
		return {
			ok: false,
			error: `Bearer token must be at most ${mcpServerBearerTokenMaxLength} characters.`,
		}
	}
	const authorization = authorizationSchemePattern.test(trimmed)
		? trimmed
		: `Bearer ${trimmed}`
	return { ok: true, authorization }
}

/**
 * Build the durable transport headers map for a normalized Authorization
 * value, or `undefined` when no static auth header should be sent.
 */
export function mcpServerAuthorizationHeaders(
	authorization: string | undefined,
): Record<string, string> | undefined {
	if (!authorization) return undefined
	return { Authorization: authorization }
}
