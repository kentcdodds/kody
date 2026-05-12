import {
	normalizeRemoteConnectorInstanceId,
	normalizeRemoteConnectorKind,
} from '@kody-internal/shared/remote-connectors.ts'

export { userScopedConnectorIngressPath } from '@kody-internal/shared/remote-connectors.ts'

export type UserScopedConnectorRouteMatch = {
	userId: string
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
		parts.length >= 5 &&
		parts[0] === 'connectors' &&
		parts[1] === 'u' &&
		parts[2] &&
		parts[3] &&
		parts[4]
	) {
		const decodedUserId = decodeSegment(parts[2])
		const decodedKind = decodeSegment(parts[3])
		const decodedInstanceId = decodeSegment(parts[4])
		if (!decodedUserId || !decodedKind || !decodedInstanceId) return null
		const userId = decodedUserId.trim()
		const kind = decodedKind.trim().toLowerCase()
		const instanceId = decodedInstanceId.trim()
		if (!userId || !kind || !instanceId) return null
		const rest = parts.length > 5 ? `/${parts.slice(5).join('/')}` : ''
		return { userId, kind, instanceId, rest }
	}
	return null
}
