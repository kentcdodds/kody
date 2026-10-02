/**
 * Scopes for Kody account API tokens (`kody_at_…`). Each resource has a
 * `:read` and `:write` scope; `:write` also satisfies `:read` for the same
 * resource. `local-execute` unlocks the CapabilityProxy for local execute venues.
 */
export const apiTokenResources = [
	'account',
	'memories',
	'secrets',
	'packages',
	'repos',
	'jobs',
	'webhooks',
	'email',
	'integrations',
	'mcp-servers',
	'runs',
	'storage',
	'community',
	'tokens',
] as const

export type ApiTokenResource = (typeof apiTokenResources)[number]

export type ApiTokenResourceScope =
	| `${ApiTokenResource}:read`
	| `${ApiTokenResource}:write`

export const localExecuteScope = 'local-execute'

export type ApiTokenScope =
	| ApiTokenResourceScope
	| 'search:read'
	| typeof localExecuteScope

const resourceDescriptions: Record<ApiTokenResource, string> = {
	account: 'account profile, usage, waiting items, and export',
	memories: 'memories and MCP server instructions',
	secrets: 'secret metadata (plaintext is never returned)',
	packages: 'saved packages, sharing, and subscriptions',
	repos: 'repos, repo sessions, edits, checks, and publishing',
	jobs: 'package jobs and workflow runs',
	webhooks: 'package webhooks and deliveries',
	email: 'inboxes, messages, senders, and send',
	integrations: 'OAuth integrations and OAuth apps',
	'mcp-servers': 'connected MCP servers',
	runs: 'execution run history',
	storage: 'durable storage export and query',
	community: 'community listings, ratings, and profile',
	tokens: 'API tokens',
}

export const apiTokenScopeDescriptions: Record<ApiTokenScope, string> = {
	...(Object.fromEntries(
		apiTokenResources.flatMap((resource) => [
			[`${resource}:read`, `Read ${resourceDescriptions[resource]}.`],
			[
				`${resource}:write`,
				`Read and change ${resourceDescriptions[resource]}.`,
			],
		]),
	) as Record<ApiTokenResourceScope, string>),
	'search:read': 'Run unified Kody search.',
	[localExecuteScope]:
		'Use the CapabilityProxy from a local execute venue (API tokens need this scope; CLI `kody login` OAuth is a separate credential).',
}

export const apiTokenScopes = Object.keys(
	apiTokenScopeDescriptions,
) as Array<ApiTokenScope>

const apiTokenScopeSet: ReadonlySet<string> = new Set(apiTokenScopes)

export function isApiTokenScope(value: unknown): value is ApiTokenScope {
	return typeof value === 'string' && apiTokenScopeSet.has(value)
}

export function apiTokenScopeSatisfies(
	granted: ReadonlyArray<ApiTokenScope>,
	required: ApiTokenScope,
) {
	if (granted.includes(required)) return true
	if (required.endsWith(':read')) {
		const writeScope = `${required.slice(0, -':read'.length)}:write`
		return granted.includes(writeScope as ApiTokenScope)
	}
	return false
}

/** Sorted, de-duplicated scopes; throws on unknown values. */
export function normalizeApiTokenScopes(values: ReadonlyArray<unknown>) {
	const unknown = values.filter((value) => !isApiTokenScope(value))
	if (unknown.length > 0) {
		throw new Error(
			`Unknown API token scope(s): ${unknown.map(String).join(', ')}.`,
		)
	}
	return [...new Set(values as ReadonlyArray<ApiTokenScope>)].sort()
}
