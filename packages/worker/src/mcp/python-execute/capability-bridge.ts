import { WorkerEntrypoint } from 'cloudflare:workers'

/**
 * Loopback entrypoint the Python isolate calls for `kody.call`.
 *
 * Pyodide structured-clone drops function arguments and `env` functions, so
 * the host passes this WorkerEntrypoint binding once per isolate. Each
 * `evaluate` sends a fresh token; the binding looks the token up in the
 * session map on this script (the same isolate that opened the session).
 */
export class PythonCapabilityBridge extends WorkerEntrypoint<
	Env,
	Record<string, never>
> {
	async call(token: string, name: string, args: unknown) {
		return await dispatchPythonCapabilitySession(token, name, args)
	}
}

type PythonCapabilitySession = {
	call: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

const sessions = new Map<string, PythonCapabilitySession>()

export type PythonCapabilityBridgeBinding = {
	call: (token: string, name: string, args: unknown) => Promise<unknown>
}

export type PythonCapabilityBridgeFactory = (options: {
	props: Record<string, never>
}) => PythonCapabilityBridgeBinding

/**
 * Node-test stand-in for `ctx.exports.PythonCapabilityBridge({ props: {} })`.
 * Workerd serves the class method; tests call this binding directly.
 */
export function pythonCapabilityBridgeBinding(): PythonCapabilityBridgeBinding {
	return {
		call(token, name, args) {
			return dispatchPythonCapabilitySession(token, name, args)
		},
	}
}

export function openPythonCapabilitySession(session: PythonCapabilitySession) {
	const token = crypto.randomUUID()
	sessions.set(token, session)
	return {
		token,
		close() {
			sessions.delete(token)
		},
	}
}

export async function dispatchPythonCapabilitySession(
	token: string,
	name: string,
	args: unknown,
) {
	const session = sessions.get(token)
	if (!session) {
		throw new Error('Python execute session is not active.')
	}
	return await session.call(name, normalizePythonCapabilityArgs(args))
}

function normalizePythonCapabilityArgs(args: unknown) {
	if (args == null) return {}
	if (typeof args !== 'object' || Array.isArray(args)) {
		throw new Error('kody.call args are a JSON object.')
	}
	return args as Record<string, unknown>
}
