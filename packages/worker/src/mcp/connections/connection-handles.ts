import { signToken, verifyToken } from './crypto.ts'

const connectionHandlePurpose = 'mcp-connection-handle'
const defaultConnectionHandleTtlMs = 5 * 60 * 1000

type ConnectionHandlePayload = {
	connection_id: string
	user_id: string
	provider_key: string
	iat: number
	exp: number
}

export async function createConnectionHandle(
	env: Env,
	input: {
		connectionId: string
		userId: string
		providerKey: string
		ttlMs?: number
	},
) {
	const now = Date.now()
	return signToken(env, connectionHandlePurpose, {
		connection_id: input.connectionId,
		user_id: input.userId,
		provider_key: input.providerKey,
		iat: now,
		exp: now + (input.ttlMs ?? defaultConnectionHandleTtlMs),
	})
}

export async function verifyConnectionHandle(env: Env, handle: string) {
	return verifyToken<ConnectionHandlePayload>(
		env,
		connectionHandlePurpose,
		handle,
	)
}
