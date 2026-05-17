import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'
import { createRemoteConnectorMcpClient } from './client.ts'
import { type RemoteConnectorSnapshot } from './types.ts'

export type RemoteConnectorStatus = {
	state: 'connected' | 'disconnected' | 'unavailable' | 'error'
	connectorKind: string
	connectorId: string | null
	connected: boolean
	connectedAt: string | null
	lastSeenAt: string | null
	toolCount: number
	message: string
	error: string | null
}

function connectorLabel(kind: string, connectorId: string) {
	const k = kind.trim().toLowerCase()
	return `${k} connector "${connectorId}"`
}

function createConnectedStatus(
	snapshot: RemoteConnectorSnapshot,
	kind: string,
): RemoteConnectorStatus {
	const resolvedKind =
		(snapshot.connectorKind ?? kind).trim().toLowerCase() || 'unknown'
	const toolCount = snapshot.tools.length
	const label = connectorLabel(resolvedKind, snapshot.connectorId)
	return {
		state: 'connected',
		connectorKind: resolvedKind,
		connectorId: snapshot.connectorId,
		connected: true,
		connectedAt: snapshot.connectedAt,
		lastSeenAt: snapshot.lastSeenAt,
		toolCount,
		message:
			toolCount > 0
				? `The ${label} is connected and exposing ${toolCount} tool${toolCount === 1 ? '' : 's'}.`
				: `The ${label} is connected, but it has not exposed any tools yet.`,
		error: null,
	}
}

function createDisconnectedStatus(
	ref: RemoteConnectorRef,
): RemoteConnectorStatus {
	const k = ref.kind.trim().toLowerCase()
	const label = connectorLabel(k, ref.instanceId)
	return {
		state: 'disconnected',
		connectorKind: k,
		connectorId: ref.instanceId,
		connected: false,
		connectedAt: null,
		lastSeenAt: null,
		toolCount: 0,
		message: `The ${label} is not connected.`,
		error: null,
	}
}

function createErrorStatus(
	ref: RemoteConnectorRef,
	error: unknown,
): RemoteConnectorStatus {
	const message = error instanceof Error ? error.message : String(error)
	const k = ref.kind.trim().toLowerCase()
	const label = connectorLabel(k, ref.instanceId)
	return {
		state: 'error',
		connectorKind: k,
		connectorId: ref.instanceId,
		connected: false,
		connectedAt: null,
		lastSeenAt: null,
		toolCount: 0,
		message: `Kody could not determine the status for the ${label}.`,
		error: message,
	}
}

export function formatRemoteConnectorUnavailableMessage(
	status: RemoteConnectorStatus,
) {
	switch (status.state) {
		case 'connected':
			if (status.toolCount > 0) {
				return status.message
			}
			return `${status.message} Capabilities from this connector cannot be searched or used until it exposes tools.`
		case 'disconnected':
			return `${status.message} Kody cannot use this connector until it reconnects. Ask the user to start or reconnect the connector and then try again.`
		case 'unavailable':
			return `${status.message} Kody cannot use this connector from this session.`
		case 'error':
			return status.error
				? `${status.message} Underlying error: ${status.error}`
				: status.message
		default: {
			const exhaustiveState: never = status.state
			throw new Error(
				`Unhandled remote connector status state: ${exhaustiveState}`,
			)
		}
	}
}

export async function getRemoteConnectorStatus(input: {
	env: Env
	userId: string
	ref: RemoteConnectorRef
}): Promise<RemoteConnectorStatus> {
	try {
		const client = createRemoteConnectorMcpClient({
			env: input.env,
			userId: input.userId,
			kind: input.ref.kind,
			instanceId: input.ref.instanceId,
		})
		const snapshot = await client.getSnapshot()
		if (!snapshot) {
			return createDisconnectedStatus(input.ref)
		}
		return createConnectedStatus(snapshot, input.ref.kind)
	} catch (error) {
		return createErrorStatus(input.ref, error)
	}
}
