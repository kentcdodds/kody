import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { packageInvocationTokenGetCapability } from '../packages/package-invocation-token-get.ts'
import { packageInvocationTokenListCapability } from '../packages/package-invocation-token-list.ts'

export const invocationTokensDomain = defineDomain({
	name: capabilityDomainNames.invocationTokens,
	description: 'Unadvertised leftover-token drain.',
	unadvertised: true,
	capabilities: [
		packageInvocationTokenListCapability,
		packageInvocationTokenGetCapability,
	],
})
