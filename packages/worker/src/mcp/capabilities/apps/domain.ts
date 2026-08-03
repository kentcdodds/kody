import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { sessionBroadcastCapability } from './session-broadcast.ts'
import { sessionEmitCapability } from './session-emit.ts'
import { sessionListCapability } from './session-list.ts'

export const appsDomain = defineDomain({
	name: capabilityDomainNames.apps,
	description: 'Package-app realtime sessions and websocket event delivery.',
	keywords: ['app', 'package app', 'realtime', 'websocket', 'session'],
	capabilities: [
		sessionEmitCapability,
		sessionBroadcastCapability,
		sessionListCapability,
	],
})
