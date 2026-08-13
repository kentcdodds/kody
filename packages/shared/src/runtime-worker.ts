/**
 * Cross-worker contract between the main `kody` Worker and the package
 * runtime Worker (`packages/runtime-worker`, script `kody-runtime`).
 *
 * The main Worker reaches the runtime Worker over a plain HTTP service
 * binding (`RUNTIME_WORKER`). The contract is deliberately coarse-grained:
 * whole runtime-owned requests (package-app origin including per-user
 * subdomains, inline package apps, package invocation API) are forwarded
 * wholesale, and the only structured endpoint is the deploy healthcheck below.
 * Durable Object access in either direction (RunLog reads from the main Worker,
 * UserMeter writes from the runtime Worker) uses cross-script Durable Object
 * bindings, not RPC.
 */

/** Healthcheck endpoint served by the runtime Worker. */
export const runtimeWorkerHealthPath = '/__runtime/health'

export type RuntimeWorkerHealth = {
	status: 'ok'
	commitSha: string | null
	cookieSecretConfigured: boolean
}

export function buildRuntimeWorkerHealth(input: {
	commitSha: string | undefined
	cookieSecretConfigured: boolean
}): RuntimeWorkerHealth {
	const trimmed = input.commitSha?.trim()
	return {
		status: 'ok',
		commitSha: trimmed ? trimmed : null,
		cookieSecretConfigured: input.cookieSecretConfigured,
	}
}
