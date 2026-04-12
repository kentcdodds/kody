/**
 * Stable Durable Object id segment for a remote connector WebSocket session.
 * For kind "home" and instanceId X, returns X unchanged so existing deployments
 * keep the same DO id as before (idFromName(connectorId) only). Home instance
 * ids containing ":" are prefixed to avoid collisions with non-home keys.
 */
export function connectorSessionKey(kind: string, instanceId: string): string {
	const k = kind.trim().toLowerCase()
	const id = instanceId.trim()
	if (k === 'home') {
		if (id.includes(':')) {
			return `home:${id}`
		}
		return id
	}
	return `${k}:${id}`
}

export function parseConnectorRoutePath(pathname: string): {
	kind: string
	instanceId: string
	rest: string
} | null {
	const parts = pathname.split('/').filter(Boolean)
	const decodeSegment = (value: string) => {
		try {
			return decodeURIComponent(value)
		} catch {
			return null
		}
	}
	// /connectors/:kind/:instanceId/...
	if (parts.length >= 3 && parts[0] === 'connectors' && parts[1] && parts[2]) {
		const decodedKind = decodeSegment(parts[1]!.trim())
		const decodedInstanceId = decodeSegment(parts[2]!.trim())
		if (!decodedKind || !decodedInstanceId) return null
		const kind = decodedKind.trim()
		const instanceId = decodedInstanceId.trim()
		if (!kind || !instanceId) return null
		const rest = parts.length > 3 ? `/${parts.slice(3).join('/')}` : ''
		return { kind, instanceId, rest }
	}
	// /home/connectors/:instanceId/...
	if (
		parts.length >= 3 &&
		parts[0] === 'home' &&
		parts[1] === 'connectors' &&
		parts[2]
	) {
		const decodedInstanceId = decodeSegment(parts[2]!.trim())
		if (!decodedInstanceId) return null
		const instanceId = decodedInstanceId.trim()
		if (!instanceId) return null
		const rest = parts.length > 3 ? `/${parts.slice(3).join('/')}` : ''
		return { kind: 'home', instanceId, rest }
	}
	return null
}

export function connectorIngressPath(kind: string, instanceId: string): string {
	const k = kind.trim().toLowerCase()
	const id = encodeURIComponent(instanceId.trim())
	if (k === 'home') {
		return `/home/connectors/${id}`
	}
	return `/connectors/${encodeURIComponent(k)}/${id}`
}
