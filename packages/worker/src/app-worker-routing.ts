/**
 * Requests owned by the Remix/content Worker (`kody-app`): everything the
 * main Worker would otherwise serve from `ASSETS` or `#app/handler` after
 * MCP, OAuth, maintenance, and runtime-owned routes.
 *
 * When the main Worker has an `APP_SURFACE` service binding it forwards
 * these wholesale; without the binding (tests, single-worker local dev) the
 * main Worker keeps serving them in-process.
 */
export function isAppSurfaceOwnedRequest(
	request: Request,
	_env: Env,
	pathname = new URL(request.url).pathname,
) {
	void _env
	return !isMainWorkerPlatformPath(pathname)
}

export function isMainWorkerPlatformPath(pathname: string) {
	if (pathname === '/mcp' || pathname === '/mcp/') return true
	if (pathname.startsWith('/oauth/')) return true
	if (pathname.startsWith('/.well-known/oauth-protected-resource')) return true
	if (pathname.startsWith('/__maintenance/')) return true
	if (pathname.startsWith('/connectors/')) return true
	return false
}
