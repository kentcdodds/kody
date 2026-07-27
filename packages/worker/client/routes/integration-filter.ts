import { matchesSearchQuery } from '#client/search-filter.ts'

export type SearchableIntegration = {
	name: string
	appSlug: string
	provider: string
	appLabel?: string | null
	accountLabel?: string | null
	tokenUrl: string
	apiBaseUrl?: string | null
	clientId: string
	clientSecretSecretName?: string | null
	accessTokenSecretName: string
	refreshTokenSecretName?: string | null
	requiredHosts?: Array<string>
	authorization?: {
		authorizeUrl: string
		scopes: Array<string>
	} | null
}

export type IntegrationAppGroup<
	integration extends SearchableIntegration = SearchableIntegration,
> = {
	appSlug: string
	provider: string
	appLabel: string | null
	clientId: string
	connections: Array<integration>
}

export function filterIntegrations<integration extends SearchableIntegration>(
	integrations: ReadonlyArray<integration>,
	query: string,
) {
	return integrations.filter((integration) =>
		matchesSearchQuery(query, [
			integration.name,
			integration.appSlug,
			integration.provider,
			integration.appLabel,
			integration.accountLabel,
			integration.tokenUrl,
			integration.apiBaseUrl,
			integration.clientId,
			integration.clientSecretSecretName,
			integration.accessTokenSecretName,
			integration.refreshTokenSecretName,
			...(integration.requiredHosts ?? []),
			integration.authorization?.authorizeUrl,
			...(integration.authorization?.scopes ?? []),
		]),
	)
}

export function groupIntegrationsByApp<
	integration extends SearchableIntegration,
>(
	integrations: ReadonlyArray<integration>,
): Array<IntegrationAppGroup<integration>> {
	const groups = new Map<string, IntegrationAppGroup<integration>>()
	for (const integration of integrations) {
		const existing = groups.get(integration.appSlug)
		if (existing) {
			existing.connections.push(integration)
			continue
		}
		groups.set(integration.appSlug, {
			appSlug: integration.appSlug,
			provider: integration.provider,
			appLabel: integration.appLabel ?? null,
			clientId: integration.clientId,
			connections: [integration],
		})
	}
	return Array.from(groups.values())
}

export function integrationDisplayName(integration: SearchableIntegration) {
	return integration.accountLabel?.trim() || integration.name
}

export function oauthAppDisplayName(group: IntegrationAppGroup) {
	return group.appLabel?.trim() || group.provider || group.appSlug
}
