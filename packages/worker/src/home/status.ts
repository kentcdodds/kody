import {
	isRemoteConnectorTrusted,
	type RemoteConnectorRef,
} from '@kody-internal/shared/remote-connectors.ts'
import { createRemoteConnectorMcpClient } from './client.ts'
import { type HomeConnectorSnapshot } from './types.ts'

export type HomeConnectorStatus = {
	state: 'connected' | 'disconnected' | 'unavailable' | 'error'
	connectorKind: string
	connectorId: string | null
	trusted: boolean
	connected: boolean
	connectedAt: string | null
	lastSeenAt: string | null
	toolCount: number
	message: string
	error: string | null
}

function connectorLabel(kind: string, connectorId: string) {
	const k = kind.trim().toLowerCase()
	if (k === 'home') {
		return `home connector "${connectorId}"`
	}
	return `${k} connector "${connectorId}"`
}

function createConnectedStatus(
	snapshot: HomeConnectorSnapshot,
	ref: RemoteConnectorRef,
): HomeConnectorStatus {
	const resolvedKind =
		(snapshot.connectorKind ?? ref.kind).trim().toLowerCase() || 'home'
	const toolCount = snapshot.tools.length
	const label = connectorLabel(resolvedKind, snapshot.connectorId)
	const trusted = isRemoteConnectorTrusted({
		...ref,
		kind: resolvedKind,
	})
	return {
		state: 'connected',
		connectorKind: resolvedKind,
		connectorId: snapshot.connectorId,
		trusted,
		connected: true,
		connectedAt: snapshot.connectedAt,
		lastSeenAt: snapshot.lastSeenAt,
		toolCount,
		message:
			!trusted && toolCount > 0
				? `The ${label} is connected and exposing ${toolCount} tool${toolCount === 1 ? '' : 's'}, but it is not trusted for capability execution in this session.`
				: toolCount > 0
				? `The ${label} is connected and exposing ${toolCount} tool${toolCount === 1 ? '' : 's'}.`
				: `The ${label} is connected, but it has not exposed any tools yet.`,
		error: null,
	}
}

function createDisconnectedStatus(
	ref: RemoteConnectorRef,
): HomeConnectorStatus {
	const k = ref.kind.trim().toLowerCase()
	const label = connectorLabel(k, ref.instanceId)
	return {
		state: 'disconnected',
		connectorKind: k,
		connectorId: ref.instanceId,
		trusted: isRemoteConnectorTrusted(ref),
		connected: false,
		connectedAt: null,
		lastSeenAt: null,
		toolCount: 0,
		message: `The ${label} is not currently connected.`,
		error: null,
	}
}

function createUnavailableStatus(): HomeConnectorStatus {
	return {
		state: 'unavailable',
		connectorKind: 'home',
		connectorId: null,
		trusted: true,
		connected: false,
		connectedAt: null,
		lastSeenAt: null,
		toolCount: 0,
		message: 'No home connector is associated with this agent context.',
		error: null,
	}
}

function createErrorStatus(
	ref: RemoteConnectorRef,
	error: unknown,
): HomeConnectorStatus {
	const message = error instanceof Error ? error.message : String(error)
	const k = ref.kind.trim().toLowerCase()
	const label = connectorLabel(k, ref.instanceId)
	return {
		state: 'error',
		connectorKind: k,
		connectorId: ref.instanceId,
		trusted: isRemoteConnectorTrusted(ref),
		connected: false,
		connectedAt: null,
		lastSeenAt: null,
		toolCount: 0,
		message: `Kody could not determine the status for the ${label}.`,
		error: message,
	}
}

export function formatHomeConnectorUnavailableMessage(
	status: HomeConnectorStatus,
) {
	return formatRemoteConnectorUnavailableMessage(status)
}

export function formatRemoteConnectorUnavailableMessage(
	status: HomeConnectorStatus,
) {
	const isHome = status.connectorKind === 'home'
	switch (status.state) {
		case 'connected':
			if (!status.trusted) {
				return `${status.message} Ask the user whether this connector should be trusted before searching or using its capabilities.`
			}
			if (status.toolCount > 0) {
				return status.message
			}
			return isHome
				? `${status.message} Home capabilities cannot be searched or used until the connector exposes tools.`
				: `${status.message} Capabilities from this connector cannot be searched or used until it exposes tools.`
		case 'disconnected':
			return isHome
				? `${status.message} Kody cannot search or use home capabilities until it reconnects. Ask the user to start or reconnect the home connector and then try again.`
				: `${status.message} Kody cannot use this connector until it reconnects. Ask the user to start or reconnect the connector and then try again.`
		case 'unavailable':
			return isHome
				? `${status.message} Kody cannot search or use home capabilities from this session.`
				: `${status.message} Kody cannot use this connector from this session.`
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

export async function getRemoteConnectorStatus(
	env: Env,
	ref: RemoteConnectorRef,
): Promise<HomeConnectorStatus> {
	try {
		const client = createRemoteConnectorMcpClient(env, ref.kind, ref.instanceId)
		const snapshot = await client.getSnapshot()
		if (!snapshot) {
			return createDisconnectedStatus(ref)
		}
		return createConnectedStatus(snapshot, ref)
	} catch (error) {
		return createErrorStatus(ref, error)
	}
}

export async function getHomeConnectorStatus(
	env: Env,
	connectorId: string | null,
): Promise<HomeConnectorStatus> {
	if (!connectorId) {
		return createUnavailableStatus()
	}

	return getRemoteConnectorStatus(env, {
		kind: 'home',
		instanceId: connectorId,
	})
}
