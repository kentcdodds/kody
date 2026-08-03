import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { integrationDeleteCapability } from './integration-delete.ts'
import { integrationDiscoverCapability } from './integration-discover.ts'
import { integrationGetCapability } from './integration-get.ts'
import { integrationListCapability } from './integration-list.ts'
import { integrationOauthAppListCapability } from './integration-oauth-app-list.ts'
import { integrationOauthAppRotateCredentialsCapability } from './integration-oauth-app-rotate-credentials.ts'
import { integrationRegistrySearchCapability } from './integration-registry-search.ts'
import { integrationSaveCapability } from './integration-save.ts'
import { openapiClientScaffoldCapability } from './openapi-client-scaffold.ts'
import { openapiSpecSummarizeCapability } from './openapi-spec-summarize.ts'

export const integrationsDomain = defineDomain({
	name: capabilityDomainNames.integrations,
	description:
		'Saved OAuth configs, provider discovery, and OpenAPI auth research.',
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
		'oauth app',
		'client credentials',
	],
	capabilities: [
		integrationSaveCapability,
		integrationGetCapability,
		integrationListCapability,
		integrationDeleteCapability,
		integrationOauthAppListCapability,
		integrationOauthAppRotateCredentialsCapability,
		integrationRegistrySearchCapability,
		integrationDiscoverCapability,
		openapiSpecSummarizeCapability,
		openapiClientScaffoldCapability,
	],
})
