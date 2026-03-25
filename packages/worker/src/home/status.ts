import { createHomeMcpClient } from './client.ts'
import { type HomeConnectorSnapshot } from './types.ts'

export type HomeConnectorStatus = {
	state: 'connected' | 'disconnected' | 'unavailable' | 'error'
	connectorId: string | null
	connected: boolean
	connectedAt: string | null
	lastSeenAt: string | null
	toolCount: number
	message: string
	error: string | null
}

function createConnectedStatus(
	snapshot: HomeConnectorSnapshot,
): HomeConnectorStatus {
	const toolCount = snapshot.tools.length
	return {
		state: 'connected',
		connectorId: snapshot.connectorId,
		connected: true,
		connectedAt: snapshot.connectedAt,
		lastSeenAt: snapshot.lastSeenAt,
		toolCount,
		message:
			toolCount > 0
				? `The home connector "${snapshot.connectorId}" is connected and exposing ${toolCount} tool${toolCount === 1 ? '' : 's'}.`
				: `The home connector "${snapshot.connectorId}" is connected, but it has not exposed any tools yet.`,
		error: null,
	}
}

function createDisconnectedStatus(connectorId: string): HomeConnectorStatus {
	return {
		state: 'disconnected',
		connectorId,
		connected: false,
		connectedAt: null,
		lastSeenAt: null,
		toolCount: 0,
		message: `The home connector "${connectorId}" is not currently connected.`,
		error: null,
	}
}

function createUnavailableStatus(): HomeConnectorStatus {
	return {
		state: 'unavailable',
		connectorId: null,
		connected: false,
		connectedAt: null,
		lastSeenAt: null,
		toolCount: 0,
		message: 'No home connector is associated with this agent context.',
		error: null,
	}
}

function createErrorStatus(
	connectorId: string,
	error: unknown,
): HomeConnectorStatus {
	const message = error instanceof Error ? error.message : String(error)
	return {
		state: 'error',
		connectorId,
		connected: false,
		connectedAt: null,
		lastSeenAt: null,
		toolCount: 0,
		message: `Kody could not determine the home connector status for "${connectorId}".`,
		error: message,
	}
}

export function formatHomeConnectorUnavailableMessage(
	status: HomeConnectorStatus,
) {
	switch (status.state) {
		case 'connected':
			if (status.toolCount > 0) {
				return status.message
			}
			return `${status.message} Home capabilities cannot be searched or used until the connector exposes tools.`
		case 'disconnected':
			return `${status.message} Kody cannot search or use home capabilities until it reconnects. Ask the user to start or reconnect the home connector and then try again.`
		case 'unavailable':
			return `${status.message} Kody cannot search or use home capabilities from this session.`
		case 'error':
			return status.error
				? `${status.message} Underlying error: ${status.error}`
				: status.message
		default: {
			const exhaustiveState: never = status.state
			throw new Error(
				`Unhandled home connector status state: ${exhaustiveState}`,
			)
		}
	}
}

export async function getHomeConnectorStatus(
	env: Env,
	connectorId: string | null,
): Promise<HomeConnectorStatus> {
	if (!connectorId) {
		return createUnavailableStatus()
	}

	try {
		const snapshot = await createHomeMcpClient(env, connectorId).getSnapshot()
		if (!snapshot) {
			return createDisconnectedStatus(connectorId)
		}
		return createConnectedStatus(snapshot)
	} catch (error) {
		return createErrorStatus(connectorId, error)
	}
}
