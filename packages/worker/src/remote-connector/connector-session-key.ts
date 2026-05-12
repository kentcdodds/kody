import {
	normalizeRemoteConnectorInstanceId,
	normalizeRemoteConnectorKind,
} from '@kody-internal/shared/remote-connectors.ts'

export { userScopedConnectorIngressPath } from '@kody-internal/shared/remote-connectors.ts'

export type UserScopedConnectorRouteMatch = {
	username: string
	kind: string
	instanceId: string
	rest: string
}

/**
 * Stable Durable Object name for a per-user remote connector WebSocket
 * session. The DO id is keyed on `(userId, kind, instanceId)` so two users
 * cannot share a connector session by registering the same `(kind,
 * instanceId)` pair. Encoded as a JSON tuple so any character (including
 * '/' and ':') in any of the three components round-trips unambiguously.
 */
export function userScopedConnectorSessionKey(input: {
	userId: string
	kind: string
	instanceId: string
}) {
	return JSON.stringify([
		input.userId.trim(),
		normalizeRemoteConnectorKind(input.kind),
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
		parts.length >= 4 &&
		parts[0]?.startsWith('@') &&
		parts[0].length > 1 &&
		parts[1] === 'connectors' &&
		parts[2] &&
		parts[3]
	) {
		const decodedUsername = decodeSegment(parts[0].slice(1))
		const decodedKind = decodeSegment(parts[2])
		const decodedInstanceId = decodeSegment(parts[3])
		if (!decodedUsername || !decodedKind || !decodedInstanceId) return null
		const username = decodedUsername.trim()
		const kind = decodedKind.trim().toLowerCase()
		const instanceId = decodedInstanceId.trim()
		if (!username || !kind || !instanceId) return null
		const rest = parts.length > 4 ? `/${parts.slice(4).join('/')}` : ''
		return { username, kind, instanceId, rest }
	}
	return null
}
