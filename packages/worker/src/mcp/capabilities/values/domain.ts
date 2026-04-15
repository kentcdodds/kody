import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { connectorDeleteCapability } from './connector-delete.ts'
import { connectorGetCapability } from './connector-get.ts'
import { connectorListCapability } from './connector-list.ts'
import { connectorSaveCapability } from './connector-save.ts'
import { skillRunnerTokenCreateCapability } from './skill-runner-token-create.ts'
import { skillRunnerTokenListCapability } from './skill-runner-token-list.ts'
import { skillRunnerTokenRevokeCapability } from './skill-runner-token-revoke.ts'
import { valueDeleteCapability } from './value-delete.ts'
import { valueGetCapability } from './value-get.ts'
import { valueListCapability } from './value-list.ts'
import { valueSetCapability } from './value-set.ts'

export const valuesDomain = defineDomain({
	name: capabilityDomainNames.values,
	description:
		'Readable persisted values for user, app, or session scoped configuration that generated UIs may store and read back later, plus external skill runner bearer token management.',
	keywords: [
		'value',
		'config',
		'storage',
		'non-secret',
		'generated ui',
		'skill runner',
		'token',
	],
	capabilities: [
		valueSetCapability,
		valueGetCapability,
		valueListCapability,
		valueDeleteCapability,
		skillRunnerTokenCreateCapability,
		skillRunnerTokenRevokeCapability,
		skillRunnerTokenListCapability,
		connectorSaveCapability,
		connectorGetCapability,
		connectorListCapability,
		connectorDeleteCapability,
	],
})
