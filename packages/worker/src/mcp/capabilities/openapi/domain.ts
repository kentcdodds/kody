import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { openapiBindingDeleteCapability } from './openapi-binding-delete.ts'
import { openapiBindingGetCapability } from './openapi-binding-get.ts'
import { openapiBindingListCapability } from './openapi-binding-list.ts'
import { openapiBindingRefreshCapability } from './openapi-binding-refresh.ts'
import { openapiBindingSaveCapability } from './openapi-binding-save.ts'

export const openapiDomain = defineDomain({
	name: capabilityDomainNames.openapi,
	description:
		'Curated OpenAPI bindings as kody.openapi["name"].operation_slug(input).',
	keywords: [
		'openapi',
		'rest',
		'api',
		'provider',
		'binding',
		'operations',
		'spec',
		'swagger',
	],
	capabilities: [
		openapiBindingSaveCapability,
		openapiBindingListCapability,
		openapiBindingGetCapability,
		openapiBindingDeleteCapability,
		openapiBindingRefreshCapability,
	],
})
