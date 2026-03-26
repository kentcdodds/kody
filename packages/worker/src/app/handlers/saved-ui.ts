import { type BuildAction } from 'remix/fetch-router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'
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

			return render(Layout({ title: artifact.title || 'Saved UI' }))
		},
	} satisfies BuildAction<
		typeof routes.savedUi.method,
		typeof routes.savedUi.pattern
	>
}
