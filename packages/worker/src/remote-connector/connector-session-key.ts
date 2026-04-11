/**
 * Stable Durable Object id segment for a remote connector WebSocket session.
 * For kind "home" and instanceId X, returns X unchanged so existing deployments
 * keep the same DO id as before (idFromName(connectorId) only).
 */
export function connectorSessionKey(kind: string, instanceId: string): string {
	const k = kind.trim().toLowerCase()
	const id = instanceId.trim()
	if (k === 'home') {
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
	// /connectors/:kind/:instanceId/...
	if (parts.length >= 3 && parts[0] === 'connectors' && parts[1] && parts[2]) {
		const kind = parts[1]!.trim()
		const instanceId = parts[2]!.trim()
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
		const instanceId = parts[2]!.trim()
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
