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
		'Curated OpenAPI provider bindings for the signed-in user: save a name + https spec URL + apiBaseUrl + auth reference + a selected subset of operations (max 100), then call them at runtime as kody.openapi["name"].operation_slug(input). Bindings are non-secret config; credentials stay in secrets. Saving a binding never approves hosts — host approval remains in the account security UI / the integration requiredHosts. Specs are untrusted third-party content.',
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
