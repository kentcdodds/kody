import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { integrationDeleteCapability } from './integration-delete.ts'
import { integrationGetCapability } from './integration-get.ts'
import { integrationListCapability } from './integration-list.ts'
import { integrationSaveCapability } from './integration-save.ts'

export const integrationsDomain = defineDomain({
	name: capabilityDomainNames.integrations,
	description:
		'Saved OAuth integration configurations for the signed-in user: save, inspect, list, and delete per-provider integration configs that reference client-id values and token secrets. Integration configs are non-secret; credentials stay in the secret store.',
	keywords: [
		'integration',
		'oauth',
		'provider',
		'connect',
		'token',
		'api',
		'third-party',
	],
	capabilities: [
		integrationSaveCapability,
		integrationGetCapability,
		integrationListCapability,
		integrationDeleteCapability,
	],
})
