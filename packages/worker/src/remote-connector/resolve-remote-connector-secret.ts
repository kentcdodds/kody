/**
 * Resolve the shared secret for a remote connector WebSocket hello.
 * Precedence: REMOTE_CONNECTOR_SECRETS map key "kind:instanceId", then
 * legacy HOME_CONNECTOR_SHARED_SECRET when kind is "home".
 */
function parseSecretsMapFromEnv(value: unknown): Record<string, string> | null {
	if (!value) return null
	if (typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, string>
	}
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (!trimmed) return null
	try {
		const parsed = JSON.parse(trimmed) as unknown
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, string>
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		console.error(
			`[REMOTE_CONNECTOR_SECRETS] invalid JSON (ignored for map lookup): ${detail}`,
		)
	}
	return null
}

export function resolveRemoteConnectorSharedSecret(
	kind: string,
	instanceId: string,
	env: Env,
): string | undefined {
	const k = kind.trim().toLowerCase()
	const id = instanceId.trim()
	const map = parseSecretsMapFromEnv(env.REMOTE_CONNECTOR_SECRETS as unknown)
	if (map) {
		const key = `${k}:${id}`
		const fromMap = map[key]
		if (typeof fromMap === 'string' && fromMap.trim()) {
			return fromMap.trim()
		}
	}
	if (k === 'home') {
		return env.HOME_CONNECTOR_SHARED_SECRET?.trim()
	}
	return undefined
}
