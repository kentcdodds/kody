import { type BuildAction } from 'remix/fetch-router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { renderHostedSavedUiHtml } from '#app/saved-ui-hosted-html.ts'
import { type routes } from '#app/routes.ts'
import { createGeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'
import { getUiArtifactByOwnerIds } from '#mcp/ui-artifacts-repo.ts'

async function getSavedUiForRequest(
	request: Request,
	env: Env,
	artifactId: string,
) {
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) return { user: null, artifact: null }
	const artifact = await getUiArtifactByOwnerIds(
		env.APP_DB,
		user.artifactOwnerIds,
		artifactId,
	)
	return { user, artifact }
}

export function createSavedUiPageHandler(env: Env) {
	return {
		middleware: [],
		async action({ request, params }) {
			const appId = params.id?.trim()
			if (!appId) {
				return new Response('Saved UI not found.', { status: 404 })
			}

			const { user, artifact } = await getSavedUiForRequest(request, env, appId)
			if (!user) {
				return redirectToLogin(request)
			}
			if (!artifact) {
				return new Response('Saved UI not found.', { status: 404 })
			}

			const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			const appSession = await createGeneratedUiAppSession({
				env,
				baseUrl,
				user: user.mcpUser,
				appId: artifact.id,
				homeConnectorId: null,
			})
			const html = renderHostedSavedUiHtml({
				artifact,
				appSession,
				appBaseUrl: baseUrl,
			})
			return new Response(html, {
				headers: {
					'Cache-Control': 'no-store',
					'Content-Type': 'text/html; charset=utf-8',
				},
			})
		},
	} satisfies BuildAction<
		typeof routes.savedUi.method,
		typeof routes.savedUi.pattern
	>
}
