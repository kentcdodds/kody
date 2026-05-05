import { type InferOutput } from 'remix/data-schema'
import { type mcpCallerContextSchema } from './chat.ts'

type McpCallerContext = InferOutput<typeof mcpCallerContextSchema>

export type RemoteConnectorRef = {
	kind: string
	instanceId: string
	/**
	 * Whether tools from this connector may be synthesized into executable
	 * capabilities. `home` defaults to trusted for backward compatibility; other
	 * connector kinds default to status-only until explicitly trusted.
	 */
	trusted?: boolean
}

export type NormalizedRemoteConnectorRef = {
	kind: string
	instanceId: string
	trusted: boolean
}

function normalizeKind(kind: string): string {
	return kind.trim().toLowerCase()
}

function normalizeInstanceId(instanceId: string): string {
	return instanceId.trim()
}

function defaultTrustedForKind(kind: string): boolean {
	return normalizeKind(kind) === 'home'
}

export function isRemoteConnectorTrusted(ref: RemoteConnectorRef): boolean {
	return ref.trusted ?? defaultTrustedForKind(ref.kind)
}

/**
 * Effective remote connectors for MCP execution, in order.
 * When `remoteConnectors` is set (including empty), it wins.
 * Otherwise `homeConnectorId` maps to `{ kind: "home", instanceId }`.
 */
export function normalizeRemoteConnectorRefs(
	context: Pick<McpCallerContext, 'homeConnectorId' | 'remoteConnectors'>,
): Array<NormalizedRemoteConnectorRef> {
	if (
		context.remoteConnectors !== undefined &&
		context.remoteConnectors !== null
	) {
		return context.remoteConnectors
			.map((ref) => {
				const kind = normalizeKind(ref.kind)
				return {
					kind,
					instanceId: normalizeInstanceId(ref.instanceId),
					trusted: ref.trusted ?? defaultTrustedForKind(kind),
				}
			})
			.filter((ref) => ref.kind.length > 0 && ref.instanceId.length > 0)
	}
	const hid = context.homeConnectorId?.trim()
	if (!hid) {
		return []
	}
	return [{ kind: 'home', instanceId: hid, trusted: true }]
}
