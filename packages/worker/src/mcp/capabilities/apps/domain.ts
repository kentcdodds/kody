import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { sessionBroadcastCapability } from './session-broadcast.ts'
import { sessionEmitCapability } from './session-emit.ts'
import { sessionListCapability } from './session-list.ts'

export const appsDomain = defineDomain({
	name: capabilityDomainNames.apps,
	description:
		'Hosted app runtime capabilities such as realtime session inspection and websocket event delivery for package apps.',
	keywords: ['app', 'package app', 'realtime', 'websocket', 'session'],
	capabilities: [
		sessionEmitCapability,
		sessionBroadcastCapability,
		sessionListCapability,
	],
})
