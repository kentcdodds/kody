import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { type UserMeterRpc } from './user-meter-do.ts'

export type UserMeterEnv = {
	USER_METER?: DurableObjectNamespace
}

export function userMeterNamespace(
	env: UserMeterEnv,
): DurableObjectNamespace | null {
	return env.USER_METER ?? null
}

/** Typed per-user UserMeter RPC stub; throws when `USER_METER` is missing. */
export function userMeterRpc(input: {
	env: UserMeterEnv
	userId: string
}): UserMeterRpc {
	const namespace = userMeterNamespace(input.env)
	if (!namespace) {
		throw new Error('USER_METER Durable Object binding is not configured.')
	}
	return namespace.get(
		namespace.idFromName(userMeterDurableObjectName(input.userId)),
	) as unknown as UserMeterRpc
}

export type { UserMeterRpc }
