/** Canonical domain id values; descriptions live on each `DomainSpec` (see `coding/domain.ts`, etc.). */
export const capabilityDomainNames = {
	account: 'account',
	admin: 'admin',
	apps: 'apps',
	community: 'community',
	coding: 'coding',
	email: 'email',
	integrations: 'integrations',
	jobs: 'jobs',
	mcpServers: 'mcpServers',
	meta: 'meta',
	packages: 'packages',
	repo: 'repo',
	runs: 'runs',
	secrets: 'secrets',
	storage: 'storage',
	values: 'values',
	webhooks: 'webhooks',
} as const

export type BuiltinCapabilityDomain =
	(typeof capabilityDomainNames)[keyof typeof capabilityDomainNames]

/** Built-in domain ids plus runtime MCP server domains (e.g. `mcp:home`). */
export type CapabilityDomain = string
