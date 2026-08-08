import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLoginWhenUnauthenticated } from '#app/auth-redirect.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { type PackageAppOwner } from '#app/package-app-owner.ts'
import { buildPackageAppNotFoundMessage } from '#worker/package-runtime/package-app-synthetic.ts'
import {
	createPackageCodeRequest,
	isPackageAppRequestPath,
	parsePackageAppPath,
	servePackageAppRequest,
	type PackageAppPath,
} from '#worker/package-runtime/package-app-serve.ts'

export {
	createPackageCodeRequest,
	isPackageAppRequestPath,
	parsePackageAppPath,
	servePackageAppRequest,
	type PackageAppPath,
}

/**
 * Serve a hosted package app inline on the app origin, authenticated by the
 * browser `kody_session` cookie.
 *
 * This is the local dev / preview / test path. When `PACKAGE_APP_BASE_URL` is
 * configured, package apps are served from that origin instead and this handler
 * is never reached — see `packages/worker/src/app/package-app-origin.ts`.
 */
export async function handlePackageAppRequest(request: Request, env: Env) {
	if (!isNonProductionRuntime(env)) {
		return new Response(
			'Hosted package apps are unavailable. Inline package-app serving is disabled in production.',
			{
				status: 500,
				headers: {
					'Cache-Control': 'no-store',
					'Content-Type': 'text/plain; charset=utf-8',
				},
			},
		)
	}

	const requestUrl = new URL(request.url)
	const packagePath = parsePackageAppPath(requestUrl.pathname)
	if (!packagePath) {
		return new Response(buildPackageAppNotFoundMessage(), { status: 404 })
	}
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return redirectToLoginWhenUnauthenticated(request, env)
	}
	const owner: PackageAppOwner = {
		userId: user.mcpUser.userId,
		username: user.username,
		email: user.email,
		displayName: user.displayName,
	}
	return await servePackageAppRequest({
		request,
		env,
		packagePath,
		owner,
	})
}
