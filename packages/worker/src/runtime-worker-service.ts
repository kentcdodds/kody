import { exports as workerExports } from 'cloudflare:workers'
import { type RuntimeWorkerServiceContract } from '@kody-internal/shared/runtime-worker.ts'

/**
 * True when this script exports `PackageAppRuntimeBridge` for loopback
 * dynamic-worker construction (runtime worker, platform worker, local
 * `index.ts`). Slim origin (`production-worker.ts`) does not.
 */
export function hasLocalPackageAppRuntimeBridge() {
	return typeof workerExports?.PackageAppRuntimeBridge === 'function'
}

/**
 * Typed `RUNTIME_WORKER` entrypoint (`RuntimeWorkerService`). Null when the
 * binding is absent (single-worker tests / local without the runtime script).
 */
export function getRuntimeWorkerService(
	env: Pick<Env, 'RUNTIME_WORKER'>,
): RuntimeWorkerServiceContract | null {
	if (!env.RUNTIME_WORKER) return null
	return env.RUNTIME_WORKER as unknown as RuntimeWorkerServiceContract
}
