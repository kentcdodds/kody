import { expect, test } from 'vitest'
import {
	formatRemoteConnectorUnavailableMessage,
	isRemoteConnectorUnavailableMessage,
	type RemoteConnectorStatus,
} from './status.ts'

function status(
	partial: Pick<RemoteConnectorStatus, 'state' | 'message' | 'toolCount'> &
		Partial<RemoteConnectorStatus>,
): RemoteConnectorStatus {
	return {
		connectorId: 'home',
		connected: partial.state === 'connected',
		connectedAt: null,
		lastSeenAt: null,
		error: null,
		...partial,
	}
}

test('isRemoteConnectorUnavailableMessage matches guidance phrases and ignores connected-tool failures', () => {
	const disconnected = formatRemoteConnectorUnavailableMessage(
		status({
			state: 'disconnected',
			toolCount: 0,
			message: 'The connector "home" is not connected.',
		}),
	)
	const emptyTools = formatRemoteConnectorUnavailableMessage(
		status({
			state: 'connected',
			toolCount: 0,
			message:
				'The connector "home" is connected, but it has not exposed any tools yet.',
		}),
	)
	const unavailable = formatRemoteConnectorUnavailableMessage(
		status({
			state: 'unavailable',
			toolCount: 0,
			message: 'The connector "home" is unavailable in this session.',
		}),
	)

	expect(isRemoteConnectorUnavailableMessage(disconnected)).toBe(true)
	expect(isRemoteConnectorUnavailableMessage(emptyTools)).toBe(true)
	expect(isRemoteConnectorUnavailableMessage(unavailable)).toBe(true)
	expect(
		isRemoteConnectorUnavailableMessage(
			'Remote capability "home:bond_shade_set_position" failed: timeout',
		),
	).toBe(false)
	expect(
		isRemoteConnectorUnavailableMessage(
			'Kody could not determine the status for the connector "home".',
		),
	).toBe(false)
})
