import { type BuildAction } from 'remix/fetch-router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { type routes } from '#app/routes.ts'
import { createGeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'
import { getSavedPackageByKodyId } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { getPackageAppEntryPath } from '#worker/package-registry/manifest.ts'
import { renderGeneratedUiDocument } from '@kody-internal/shared/generated-ui-documents.ts'

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
			const appEntry = getPackageAppEntryPath(packageSource.manifest)
			if (!appEntry) {
				return new Response('Saved package app is not configured.', {
					status: 404,
				})
			}
			const appSession = await createGeneratedUiAppSession({
				env,
				baseUrl,
				user: user.mcpUser,
				appId: savedPackage.id,
			})
			const html = renderGeneratedUiDocument({
				code: `<main><h1>${savedPackage.name}</h1><p>This saved package app is hosted from \`${appEntry}\`.</p></main>`,
				runtime: 'html',
				headInjection: '',
				baseHref: baseUrl,
			})
			return new Response(html, {
				headers: {
					'Cache-Control': 'no-store',
					'Content-Type': 'text/html; charset=utf-8',
					'X-Kody-Package-App-Session': appSession.sessionId,
				},
			})
		},
	} satisfies BuildAction<
		typeof routes.packageApp.method,
		typeof routes.packageApp.pattern
	>
}
