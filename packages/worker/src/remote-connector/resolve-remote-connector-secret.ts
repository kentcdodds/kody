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

async function listStoredSharedSecrets(input: {
	userId: string
	kind: string
	instanceId: string
	env: Env
}) {
	try {
		return await listRemoteConnectorSharedSecretsForRef({
			env: input.env,
			userId: input.userId,
			kind: input.kind,
			instanceId: input.instanceId,
		})
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		console.error(
			`[remote-connectors] failed to read persisted shared secrets for ${input.userId} ${normalizeRemoteConnectorKind(input.kind)}:${normalizeRemoteConnectorInstanceId(input.instanceId)}: ${detail}`,
		)
		return []
	}
}

async function storedSharedSecretExists(input: {
	userId: string
	kind: string
	instanceId: string
	env: Env
}) {
	try {
		return await hasRemoteConnectorSharedSecretForRef({
			env: input.env,
			userId: input.userId,
			kind: input.kind,
			instanceId: input.instanceId,
		})
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		console.error(
			`[remote-connectors] failed to check persisted shared secret for ${input.userId} ${normalizeRemoteConnectorKind(input.kind)}:${normalizeRemoteConnectorInstanceId(input.instanceId)}: ${detail}`,
		)
		return false
	}
}

export async function resolveRemoteConnectorSharedSecret(input: {
	userId: string
	kind: string
	instanceId: string
	env: Env
}): Promise<string | undefined> {
	const [storedSecret] = await listStoredSharedSecrets(input)
	return storedSecret
}

export async function remoteConnectorSharedSecretMatches(input: {
	userId: string
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
	return false
}

export async function hasRemoteConnectorSharedSecret(input: {
	userId: string
	kind: string
	instanceId: string
	env: Env
}): Promise<boolean> {
	return storedSharedSecretExists(input)
}
