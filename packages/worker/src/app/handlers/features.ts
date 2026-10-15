import { type Action } from 'remix/router'
import { renderAppPage } from '#app/ssr-render.tsx'
import { routes } from '#universal/routes.ts'

export function createFeaturesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return renderAppPage({
				request,
				env,
			})
		},
	} satisfies Action<typeof routes.features>
}

/**
 * Secrets and integrations merged into one credentials page. Keep permanent
 * redirects so shared links and search results land on it.
 */
export function createLegacyFeatureCredentialsRedirectHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const { search } = new URL(request.url)
			return new Response(null, {
				status: 301,
				headers: {
					Location: `${routes.featureCredentials.href()}${search}`,
					'Cache-Control': 'public, max-age=3600',
				},
			})
		},
	} satisfies Action<typeof routes.featureSecrets>
}
