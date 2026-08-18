/**
 * Stable instance names used for user-owned resources (repos, MCP server
 * kody names, etc.): lowercase letters, digits, and dashes; start and end
 * with a letter or digit; at most 64 characters.
 */
export const kodyInstanceNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export function normalizeKodyInstanceName(name: string): string {
	return name.trim().toLowerCase()
}

export function isValidKodyInstanceName(name: string): boolean {
	return kodyInstanceNamePattern.test(normalizeKodyInstanceName(name))
}
