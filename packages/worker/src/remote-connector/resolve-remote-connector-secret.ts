import {
	hasRemoteConnectorSharedSecretForRef,
	listRemoteConnectorSharedSecretsForRef,
	normalizeRemoteConnectorInstanceId,
	normalizeRemoteConnectorKind,
} from './settings-service.ts'

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

function resolveRemoteConnectorSharedSecretFromEnv(
	kind: string,
	instanceId: string,
	env: Env,
): string | undefined {
	const k = normalizeRemoteConnectorKind(kind)
	const id = normalizeRemoteConnectorInstanceId(instanceId)
	const map = parseSecretsMapFromEnv(env.REMOTE_CONNECTOR_SECRETS as unknown)
	if (map) {
		const key = `${k}:${id}`
		const fromMap = map[key]
		if (typeof fromMap === 'string' && fromMap.trim()) {
			return fromMap.trim()
		}
	}
	return undefined
}

async function listStoredSharedSecrets(input: {
	kind: string
	instanceId: string
	env: Env
}) {
	try {
		return await listRemoteConnectorSharedSecretsForRef({
			env: input.env,
			kind: input.kind,
			instanceId: input.instanceId,
		})
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		console.error(
			`[remote-connectors] failed to read persisted shared secrets for ${normalizeRemoteConnectorKind(input.kind)}:${normalizeRemoteConnectorInstanceId(input.instanceId)} (falling back to env map): ${detail}`,
		)
		return []
	}
}

async function storedSharedSecretExists(input: {
	kind: string
	instanceId: string
	env: Env
}) {
	try {
		return await hasRemoteConnectorSharedSecretForRef({
			env: input.env,
			kind: input.kind,
			instanceId: input.instanceId,
		})
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		console.error(
			`[remote-connectors] failed to check persisted shared secret for ${normalizeRemoteConnectorKind(input.kind)}:${normalizeRemoteConnectorInstanceId(input.instanceId)} (falling back to env map): ${detail}`,
		)
		return false
	}
}

export async function resolveRemoteConnectorSharedSecret(
	kind: string,
	instanceId: string,
	env: Env,
): Promise<string | undefined> {
	const [storedSecret] = await listStoredSharedSecrets({
		kind,
		instanceId,
		env,
	})
	if (storedSecret) return storedSecret
	return resolveRemoteConnectorSharedSecretFromEnv(kind, instanceId, env)
}

export async function remoteConnectorSharedSecretMatches(input: {
	kind: string
	instanceId: string
	sharedSecret: string
	env: Env
}): Promise<boolean> {
	const storedSecrets = await listStoredSharedSecrets(input)
	if (storedSecrets.some((secret) => input.sharedSecret === secret)) {
		return true
	}
	const fallbackSecret = resolveRemoteConnectorSharedSecretFromEnv(
		input.kind,
		input.instanceId,
		input.env,
	)
	return Boolean(fallbackSecret && input.sharedSecret === fallbackSecret)
}

export async function hasRemoteConnectorSharedSecret(input: {
	kind: string
	instanceId: string
	env: Env
}): Promise<boolean> {
	if (await storedSharedSecretExists(input)) return true
	return Boolean(
		resolveRemoteConnectorSharedSecretFromEnv(
			input.kind,
			input.instanceId,
			input.env,
		),
	)
}
