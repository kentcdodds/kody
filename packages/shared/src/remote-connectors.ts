import { type InferOutput } from 'remix/data-schema'
import { type mcpCallerContextSchema } from './chat.ts'
import { buildUsernamePathPrefix } from './public-urls.ts'

type McpCallerContext = InferOutput<typeof mcpCallerContextSchema>

export type RemoteConnectorRef = {
	instanceId: string
}

export const remoteConnectorNamePattern =
	/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export function normalizeRemoteConnectorInstanceId(instanceId: string): string {
	return instanceId.trim().toLowerCase()
}

export function isValidRemoteConnectorName(instanceId: string): boolean {
	return remoteConnectorNamePattern.test(
		normalizeRemoteConnectorInstanceId(instanceId),
	)
}

export function userScopedConnectorIngressPath(input: {
	username: string
	instanceId: string
}) {
	const instanceId = encodeURIComponent(
		normalizeRemoteConnectorInstanceId(input.instanceId),
	)
	return `${buildUsernamePathPrefix(input.username)}/connectors/${instanceId}`
}

export function userScopedConnectorWebSocketUrl(input: {
	origin: string
	username: string
	instanceId: string
}) {
	const origin = input.origin.trim().replace(/\/+$/, '')
	return `${origin}${userScopedConnectorIngressPath(input)}`
}

export function normalizeRemoteConnectorRefs(
	context: Pick<McpCallerContext, 'remoteConnectors'>,
): Array<RemoteConnectorRef> {
	return (context.remoteConnectors ?? [])
		.map((ref) => ({
			instanceId: normalizeRemoteConnectorInstanceId(ref.instanceId),
		}))
		.filter((ref) => ref.instanceId.length > 0)
}
