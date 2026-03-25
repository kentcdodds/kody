import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { connectionsBeginSetupCapability } from './connections-begin-setup.ts'
import { connectionsDisconnectCapability } from './connections-disconnect.ts'
import { connectionsFinalizeCapability } from './connections-finalize.ts'
import { connectionsListCapability } from './connections-list.ts'
import { connectionsResolveCapability } from './connections-resolve.ts'
import { connectionsSetDefaultCapability } from './connections-set-default.ts'
import { connectionsStartOauthCapability } from './connections-start-oauth.ts'
import { providerGraphqlRequestCapability } from './provider-graphql-request.ts'
import { providerHttpRequestCapability } from './provider-http-request.ts'
import { providerRefreshTokenCapability } from './provider-refresh-token.ts'

export const connectionsDomain = defineDomain({
	name: capabilityDomainNames.connections,
	description:
		'Provider connection setup, OAuth orchestration, secure token-backed handles, generic authenticated HTTP/GraphQL requests, and multi-connection account management.',
	keywords: [
		'connections',
		'provider',
		'oauth',
		'api key',
		'manual token',
		'secure input',
		'handle',
	],
	capabilities: [
		connectionsBeginSetupCapability,
		connectionsListCapability,
		connectionsResolveCapability,
		connectionsSetDefaultCapability,
		connectionsDisconnectCapability,
		connectionsStartOauthCapability,
		connectionsFinalizeCapability,
		providerHttpRequestCapability,
		providerGraphqlRequestCapability,
		providerRefreshTokenCapability,
	],
})
