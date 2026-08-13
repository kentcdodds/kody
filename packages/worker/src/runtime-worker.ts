import * as Sentry from '@sentry/cloudflare'
import {
	buildRuntimeWorkerHealth,
	runtimeWorkerHealthPath,
} from '@kody-internal/shared/runtime-worker.ts'
import { StorageRunner } from './storage-runner.ts'
import { RunLog } from './run-records/run-log-do.ts'
import { PackageRealtimeSession } from '#worker/package-runtime/realtime-session.ts'
import { PackageServiceInstance } from '#worker/package-runtime/package-service.ts'
import { DynamicCallableWorkflow } from '#worker/package-runtime/package-workflows.ts'
import { PackageAppRuntimeBridge } from '#worker/package-runtime/package-app.ts'
import { KodyFetchGateway } from '#mcp/fetch-gateway.ts'
import { getWorkerSentryOptions } from './sentry-options.ts'
import {
	handlePackageInvocationApiRequest,
	isPackageInvocationApiRequest,
} from './package-invocations/http.ts'
import {
	handlePackageAppRequest,
	isPackageAppRequestPath,
} from '#app/handlers/package-app.ts'
import { handlePackageAppOriginRequest } from '#app/package-app-origin.ts'

/**
 * Package runtime Worker entrypoint (script `kody-runtime`, deployed from
 * `packages/runtime-worker/wrangler.jsonc`).
 *
 * Owns the untrusted-code execution lane extracted from the main `kody`
 * Worker per ADR 0016: the package-app origin (`PACKAGE_APP_BASE_URL`),
 * inline package-app serving, the package invocation API, dynamic callable
 * workflows, and the runtime Durable Objects exported below. The main Worker
 * forwards runtime-owned requests here over the `RUNTIME_WORKER` service
 * binding (see `runtime-worker-routing.ts` and
 * `@kody-internal/shared/runtime-worker.ts`).
 *
 * `KodyFetchGateway` and `PackageAppRuntimeBridge` are loopback
 * `ctx.exports` entrypoints for dynamically loaded package isolates, so this
 * script exports its own instances rather than calling back into the main
 * Worker.
 */
export {
	StorageRunner,
	RunLog,
	PackageRealtimeSession,
	PackageServiceInstance,
	DynamicCallableWorkflow,
	PackageAppRuntimeBridge,
	KodyFetchGateway,
}

const runtimeWorkerHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url)

		if (url.pathname === runtimeWorkerHealthPath) {
			return Response.json(
				buildRuntimeWorkerHealth({
					commitSha: (env as { APP_COMMIT_SHA?: string }).APP_COMMIT_SHA,
					cookieSecretConfigured: Boolean(env.COOKIE_SECRET?.trim()),
				}),
			)
		}

		const packageAppOriginResponse = await handlePackageAppOriginRequest(
			request,
			env,
		)
		if (packageAppOriginResponse) return packageAppOriginResponse

		if (isPackageInvocationApiRequest(url.pathname)) {
			return handlePackageInvocationApiRequest(request, env, ctx)
		}

		if (isPackageAppRequestPath(url.pathname)) {
			return handlePackageAppRequest(request, env)
		}

		return new Response('Not Found', { status: 404 })
	},
} satisfies ExportedHandler<Env>

export default Sentry.withSentry(
	(env: Env) => getWorkerSentryOptions(env),
	runtimeWorkerHandler,
)
