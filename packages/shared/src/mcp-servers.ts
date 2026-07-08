export type McpServerRef = {
	serverId: string
	name: string
}

export const mcpServerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

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
