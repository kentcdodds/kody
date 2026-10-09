/** Org slug rules for OAuth `?org=` (public surface — never an org id). */

export function normalizeOrgSlug(value: string) {
	return value.trim().toLowerCase()
}

export function readOrgSlugFromUrl(url: string | URL): string | null {
	try {
		const parsed = typeof url === 'string' ? new URL(url) : url
		const value = parsed.searchParams.get('org')
		if (value === null) return null
		const slug = normalizeOrgSlug(value)
		return slug.length > 0 ? slug : null
	} catch {
		return null
	}
}

/** Build the MCP URL with `?org=` (lowercase slug). */
export function buildOrgBoundMcpUrl(input: {
	mcpServerUrl: string
	orgSlug: string
}) {
	const url = new URL(input.mcpServerUrl)
	url.searchParams.set('org', normalizeOrgSlug(input.orgSlug))
	return url.toString()
}

/**
 * Pull an org slug from an OAuth resource URI that may carry `?org=`.
 * Removes only `org` so a sibling `?profile=` survives until profile
 * resolution canonicalizes the `/mcp` audience.
 */
export function stripOrgFromResourceUri(resource: string): {
	canonicalResource: string
	orgSlug: string | null
} {
	try {
		const url = new URL(resource)
		const orgSlug = readOrgSlugFromUrl(url)
		url.searchParams.delete('org')
		return {
			canonicalResource: url.toString(),
			orgSlug,
		}
	} catch {
		return { canonicalResource: resource, orgSlug: null }
	}
}
