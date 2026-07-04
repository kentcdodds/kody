import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { integrationDeleteCapability } from './integration-delete.ts'
import { integrationDiscoverCapability } from './integration-discover.ts'
import { integrationGetCapability } from './integration-get.ts'
import { integrationListCapability } from './integration-list.ts'
import { integrationRegistrySearchCapability } from './integration-registry-search.ts'
import { integrationSaveCapability } from './integration-save.ts'

export const integrationsDomain = defineDomain({
	name: capabilityDomainNames.integrations,
	description:
		'Saved OAuth integration configurations for the signed-in user: save, inspect, list, and delete per-provider integration configs that reference client-id values and token secrets. Integration configs are non-secret; credentials stay in the secret store. Also includes integrations.sh registry-backed discovery capabilities to research provider auth contracts before saving integrations.',
	keywords: [
		'integration',
		'oauth',
		'provider',
		'connect',
		'token',
		'api',
		'third-party',
		'discovery',
		'integrations.sh',
	],
	capabilities: [
		integrationSaveCapability,
		integrationGetCapability,
		integrationListCapability,
		integrationDeleteCapability,
		integrationRegistrySearchCapability,
		integrationDiscoverCapability,
	],
})
