import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { isPackageInvocationApiRequest } from '#worker/package-invocations/http.ts'
import { isPackageAppRequestPath } from '#worker/package-runtime/package-app-serve.ts'

/**
 * Requests owned by the package runtime Worker (`kody-runtime`): everything on
 * the package-app origin, inline package-app paths on the app origin, and the
 * package invocation API. When the main Worker has a `RUNTIME_WORKER` service
 * binding it forwards these wholesale; without the binding (tests, single
 * Worker local dev) the main Worker keeps serving them in-process.
 */
export function isRuntimeWorkerOwnedRequest(request: Request, env: Env) {
	const url = new URL(request.url)
	const packageAppOrigin = getPackageAppBaseUrl({ env })
	if (packageAppOrigin && url.origin === packageAppOrigin) return true
	return (
		isPackageInvocationApiRequest(url.pathname) ||
		isPackageAppRequestPath(url.pathname)
	)
}
