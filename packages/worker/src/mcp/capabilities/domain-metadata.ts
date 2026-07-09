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
	math: 'math',
	mcpServers: 'mcp_servers',
	meta: 'meta',
	openapi: 'openapi',
	packages: 'packages',
	repo: 'repo',
	secrets: 'secrets',
	services: 'services',
	storage: 'storage',
	values: 'values',
} as const

export type BuiltinCapabilityDomain =
	(typeof capabilityDomainNames)[keyof typeof capabilityDomainNames]

/** Built-in domain ids plus runtime remote-connector domains (e.g. `remote:lights`). */
export type CapabilityDomain = string
