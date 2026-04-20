import { type BuildAction } from 'remix/fetch-router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { type routes } from '#app/routes.ts'
import { getSavedPackageByKodyId } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import {
	buildPackageAppWorker,
	createPackageAppCallerContext,
} from '#worker/package-runtime/package-app.ts'

export function createPackageAppPageHandler(env: Env) {
	return {
		middleware: [],
		async action({ request, params }) {
			const kodyId = params.kodyId?.trim()
			if (!kodyId) {
				return new Response('Saved package app not found.', { status: 404 })
			}
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLogin(request)
			}
			const savedPackage = await getSavedPackageByKodyId(env.APP_DB, {
				userId: user.mcpUser.userId,
				kodyId,
			})
			if (!savedPackage || !savedPackage.hasApp) {
				return new Response('Saved package app not found.', { status: 404 })
			}
			const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			const packageSource = await loadPackageSourceBySourceId({
				env,
				baseUrl,
				userId: user.mcpUser.userId,
				sourceId: savedPackage.sourceId,
			})
			const callerContext = await createPackageAppCallerContext({
				baseUrl,
				user: {
					userId: user.mcpUser.userId,
					email: user.email,
					displayName: user.displayName,
				},
				packageId: savedPackage.id,
			})
			const appWorker = await buildPackageAppWorker({
				env,
				baseUrl,
				userId: user.mcpUser.userId,
				savedPackage: {
					id: savedPackage.id,
					kodyId: savedPackage.kodyId,
					name: savedPackage.name,
					sourceId: savedPackage.sourceId,
				},
				sourceFiles: packageSource.files,
				runtime: {
					callerContext,
				},
			})
			const entrypoint = appWorker.stub.getEntrypoint(appWorker.entrypointName)
			return await entrypoint.fetch(request)
		},
	} satisfies BuildAction<
		typeof routes.packageApp.method,
		typeof routes.packageApp.pattern
	>
}
