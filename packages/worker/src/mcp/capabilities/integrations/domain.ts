import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { integrationDeleteCapability } from './integration-delete.ts'
import { integrationDiscoverCapability } from './integration-discover.ts'
import { integrationGetCapability } from './integration-get.ts'
import { integrationListCapability } from './integration-list.ts'
import { integrationRegistrySearchCapability } from './integration-registry-search.ts'
import { integrationSaveCapability } from './integration-save.ts'
import { openapiClientScaffoldCapability } from './openapi-client-scaffold.ts'
import { openapiSpecSummarizeCapability } from './openapi-spec-summarize.ts'

export const integrationsDomain = defineDomain({
	name: capabilityDomainNames.integrations,
	description:
		'Saved OAuth integration configs for the signed-in user (non-secret; credentials stay in the secret store), plus registry-backed provider discovery and OpenAPI spec summarization for researching provider auth contracts.',
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
		'openapi',
		'spec',
		'scaffold',
	],
	capabilities: [
		integrationSaveCapability,
		integrationGetCapability,
		integrationListCapability,
		integrationDeleteCapability,
		integrationRegistrySearchCapability,
		integrationDiscoverCapability,
		openapiSpecSummarizeCapability,
		openapiClientScaffoldCapability,
	],
})
