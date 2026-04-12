import { type InferOutput } from 'remix/data-schema'
import { type mcpCallerContextSchema } from './chat.ts'

type McpCallerContext = InferOutput<typeof mcpCallerContextSchema>

export type RemoteConnectorRef = {
	kind: string
	instanceId: string
}

function normalizeKind(kind: string): string {
	return kind.trim().toLowerCase()
}

function normalizeInstanceId(instanceId: string): string {
	return instanceId.trim()
}

/**
 * Effective remote connectors for MCP execution, in order.
 * When `remoteConnectors` is set (including empty), it wins.
 * Otherwise `homeConnectorId` maps to `{ kind: "home", instanceId }`.
 */
export function normalizeRemoteConnectorRefs(
	context: Pick<McpCallerContext, 'homeConnectorId' | 'remoteConnectors'>,
): Array<RemoteConnectorRef> {
	if (
		context.remoteConnectors !== undefined &&
		context.remoteConnectors !== null
	) {
		return context.remoteConnectors
			.map((ref) => ({
				kind: normalizeKind(ref.kind),
				instanceId: normalizeInstanceId(ref.instanceId),
			}))
			.filter((ref) => ref.kind.length > 0 && ref.instanceId.length > 0)
	}
	const hid = context.homeConnectorId?.trim()
	if (!hid) {
		return []
	}
	return [{ kind: 'home', instanceId: hid }]
}
