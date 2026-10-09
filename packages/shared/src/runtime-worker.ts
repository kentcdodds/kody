/**
 * Cross-worker contract between the main `kody` Worker and the package
 * runtime Worker (`packages/runtime-worker`, script `kody-runtime`).
 *
 * The main Worker reaches the runtime Worker over the `RUNTIME_WORKER`
 * service binding. Wholesale HTTP forward covers runtime-owned requests
 * (package-app origin including per-user subdomains, inline package apps,
 * package invocation API). Structured calls:
 * - `GET /__runtime/health` — deploy healthcheck
 * - `RuntimeWorkerService.servePackageApp` — in-process package-app serve for
 *   scripts that lack loopback `PackageAppRuntimeBridge` (slim origin MCP)
 *
 * Durable Object access in either direction (RunLog reads from the main Worker,
 * UserMeter writes from the runtime Worker) uses cross-script Durable Object
 * bindings, not this RPC surface.
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

/**
 * Owner already authenticated by the caller (MCP session or package-app
 * session). Runtime must not re-check package-app cookies for this path.
 */
export type RuntimePackageAppServeOwner = {
	userId: string
	username: string
	email: string
	displayName: string
}

export type RuntimePackageAppPath = {
	username: string
	kodyId: string
	restPath: string
	mount: 'user-subdomain' | 'username-path'
}

export type RuntimePackageAppServeInput = {
	request: Request
	owner: RuntimePackageAppServeOwner
	packagePath: RuntimePackageAppPath
	dispatch?: { readonly synthetic: true }
}

/**
 * `RUNTIME_WORKER` service binding entrypoint (`RuntimeWorkerService`).
 * `.fetch` keeps wholesale HTTP forward; `servePackageApp` is the only
 * structured serve call for slim-origin in-process callers.
 */
export type RuntimeWorkerServiceContract = {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
	servePackageApp(input: RuntimePackageAppServeInput): Promise<Response>
}
