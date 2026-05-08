import {
	hasRemoteConnectorSharedSecretForRef,
	listRemoteConnectorSharedSecretsForRef,
	normalizeRemoteConnectorInstanceId,
	normalizeRemoteConnectorKind,
} from './settings-service.ts'

const textEncoder = new TextEncoder()

function padToLength(buffer: Uint8Array, length: number) {
	if (buffer.length === length) return buffer
	const padded = new Uint8Array(length)
	padded.set(buffer)
	return padded
}

function timingSafeStringEquals(left: string, right: string) {
	const leftBytes = textEncoder.encode(left)
	const rightBytes = textEncoder.encode(right)
	const length = Math.max(leftBytes.length, rightBytes.length)
	const leftPadded = padToLength(leftBytes, length)
	const rightPadded = padToLength(rightBytes, length)
	const subtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (
			a: ArrayBuffer | ArrayBufferView,
			b: ArrayBuffer | ArrayBufferView,
		) => boolean
	}
	const isEqual =
		typeof subtle.timingSafeEqual === 'function'
			? subtle.timingSafeEqual(leftPadded, rightPadded)
			: (() => {
					let result = 0
					for (let index = 0; index < length; index += 1) {
						result |= (leftPadded[index] ?? 0) ^ (rightPadded[index] ?? 0)
					}
					return result === 0
				})()
	return isEqual && leftBytes.length === rightBytes.length
}

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
	let storedSecretMatches = false
	for (const secret of storedSecrets) {
		if (timingSafeStringEquals(input.sharedSecret, secret)) {
			storedSecretMatches = true
		}
	}
	if (storedSecretMatches) {
		return true
	}
	const fallbackSecret = resolveRemoteConnectorSharedSecretFromEnv(
		input.kind,
		input.instanceId,
		input.env,
	)
	return Boolean(
		fallbackSecret &&
		timingSafeStringEquals(input.sharedSecret, fallbackSecret),
	)
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
