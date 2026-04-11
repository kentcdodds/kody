/**
 * Resolve the shared secret for a remote connector WebSocket hello.
 * Precedence: REMOTE_CONNECTOR_SECRETS JSON map key "kind:instanceId", then
 * legacy HOME_CONNECTOR_SHARED_SECRET when kind is "home".
 */
export function resolveRemoteConnectorSharedSecret(
	kind: string,
	instanceId: string,
	env: Env,
): string | undefined {
	const k = kind.trim().toLowerCase()
	const id = instanceId.trim()
	const mapRaw = env.REMOTE_CONNECTOR_SECRETS?.trim()
	if (mapRaw) {
		try {
			const parsed = JSON.parse(mapRaw) as unknown
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const key = `${k}:${id}`
				const fromMap = (parsed as Record<string, unknown>)[key]
				if (typeof fromMap === 'string' && fromMap.trim()) {
					return fromMap.trim()
				}
			}
		} catch {
			// fall through to legacy
		}
	}
	if (k === 'home') {
		return env.HOME_CONNECTOR_SHARED_SECRET?.trim()
	}
	return undefined
}
