import { type InferOutput } from 'remix/data-schema'
import { type mcpCallerContextSchema } from './chat.ts'
import { buildUsernamePathPrefix } from './public-urls.ts'

type McpCallerContext = InferOutput<typeof mcpCallerContextSchema>

export type RemoteConnectorRef = {
	kind: string
	instanceId: string
}

export function normalizeRemoteConnectorKind(kind: string): string {
	return kind.trim().toLowerCase()
}

export function normalizeRemoteConnectorInstanceId(instanceId: string): string {
	return instanceId.trim()
}

export function userScopedConnectorIngressPath(input: {
	username: string
	kind: string
	instanceId: string
}) {
	const kind = encodeURIComponent(normalizeRemoteConnectorKind(input.kind))
	const instanceId = encodeURIComponent(
		normalizeRemoteConnectorInstanceId(input.instanceId),
	)
	return `${buildUsernamePathPrefix(input.username)}/connectors/${kind}/${instanceId}`
}

export function userScopedConnectorWebSocketUrl(input: {
	origin: string
	username: string
	kind: string
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
			kind: normalizeRemoteConnectorKind(ref.kind),
			instanceId: normalizeRemoteConnectorInstanceId(ref.instanceId),
		}))
		.filter((ref) => ref.kind.length > 0 && ref.instanceId.length > 0)
}
