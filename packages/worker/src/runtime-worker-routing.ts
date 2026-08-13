import { parsePackageAppRequestHost } from '#worker/app-base-url.ts'
import { isPackageInvocationApiRequest } from '#worker/package-invocations/http.ts'
import { isPackageAppRequestPath } from '#worker/package-runtime/package-app-serve.ts'

/**
 * Requests owned by the package runtime Worker (`kody-runtime`): everything on
 * the package-app origin (apex, per-user subdomains, and unrecognized labels
 * the wildcard still delivers), inline package-app paths on the app origin, and
 * the package invocation API. When the main Worker has a `RUNTIME_WORKER`
 * service binding it forwards these wholesale; without the binding (tests,
 * single Worker local dev) the main Worker keeps serving them in-process.
 *
 * Matching the apex origin alone is not enough. Production serves each owner's
 * apps on `{username}.<package-app host>`, and the handoff token is exchanged
 * there. If that request ever lands on the main Worker (leftover zone route,
 * workers.dev probe, mis-attached custom domain), it must still reach the same
 * script that minted the token — otherwise HMAC verification uses a different
 * `COOKIE_SECRET` and the visitor is stuck on the 403 handoff page with
 * `__kody_handoff` still in the URL.
 */
export function isRuntimeWorkerOwnedRequest(request: Request, env: Env) {
	const url = new URL(request.url)
	if (parsePackageAppRequestHost({ env, url })) return true
	return (
		isPackageInvocationApiRequest(url.pathname) ||
		isPackageAppRequestPath(url.pathname)
	)
}
