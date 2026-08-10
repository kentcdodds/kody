import {
	isValidRemoteConnectorName,
	normalizeRemoteConnectorInstanceId,
} from '@kody-internal/shared/remote-connectors.ts'
import { durableObjectNameFromParts } from '#worker/user-scoped-durable-object-name.ts'

export type UserScopedConnectorRouteMatch = {
	username: string
	instanceId: string
	rest: string
}

/**
 * Stable Durable Object name for a per-user remote connector WebSocket
 * session. The DO id is keyed on `(userId, instanceId)` so two users
 * cannot share a connector session by registering the same instance id.
 * Encoded as a JSON tuple so any character (including '/' and ':') in any
 * of the components round-trips unambiguously.
 */
export function userScopedConnectorSessionKey(input: {
	userId: string
	instanceId: string
}) {
	return durableObjectNameFromParts([
		input.userId.trim(),
		normalizeRemoteConnectorInstanceId(input.instanceId),
	])
}

export function parseUserScopedConnectorRoutePath(
	pathname: string,
): UserScopedConnectorRouteMatch | null {
	const parts = pathname.split('/').filter(Boolean)
	const decodeSegment = (value: string): string | null => {
		try {
			return decodeURIComponent(value)
		} catch {
			return null
		}
	}
	if (
		parts.length >= 3 &&
		parts[0]?.startsWith('@') &&
		parts[0].length > 1 &&
		parts[1] === 'connectors' &&
		parts[2]
	) {
		const decodedUsername = decodeSegment(parts[0].slice(1))
		const decodedInstanceId = decodeSegment(parts[2])
		if (!decodedUsername || !decodedInstanceId) return null
		const username = decodedUsername.trim()
		const instanceId = normalizeRemoteConnectorInstanceId(decodedInstanceId)
		if (!username || !isValidRemoteConnectorName(instanceId)) return null
		const rest = parts.length > 3 ? `/${parts.slice(3).join('/')}` : ''
		return { username, instanceId, rest }
	}
	return null
}
