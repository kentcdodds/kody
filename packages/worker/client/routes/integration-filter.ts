import { matchesSearchQuery } from '#client/search-filter.ts'

export type SearchableIntegration = {
	name: string
	valueName: string
	tokenUrl: string
	apiBaseUrl?: string | null
	clientIdValueName: string
	clientSecretSecretName?: string | null
	accessTokenSecretName: string
	refreshTokenSecretName?: string | null
	requiredHosts?: Array<string>
	authorization?: {
		authorizeUrl: string
		scopes: Array<string>
	} | null
}

export function filterIntegrations<integration extends SearchableIntegration>(
	integrations: ReadonlyArray<integration>,
	query: string,
) {
	return integrations.filter((integration) =>
		matchesSearchQuery(query, [
			integration.name,
			integration.valueName,
			integration.tokenUrl,
			integration.apiBaseUrl,
			integration.clientIdValueName,
			integration.clientSecretSecretName,
			integration.accessTokenSecretName,
			integration.refreshTokenSecretName,
			...(integration.requiredHosts ?? []),
			integration.authorization?.authorizeUrl,
			...(integration.authorization?.scopes ?? []),
		]),
	)
}
