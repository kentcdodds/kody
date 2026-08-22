import { jsonResponse } from '#worker/json-response.ts'
import { loadPublicCodeRunsWindow } from '#worker/usage/code-runs-window.ts'
import { type routes } from '#universal/routes.ts'
import { type Action } from 'remix/router'

export function createCodeRunsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler() {
			const window = await loadPublicCodeRunsWindow(env)
			return jsonResponse(
				{ ok: true, window },
				{
					headers: {
						'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
					},
				},
			)
		},
	} satisfies Action<typeof routes.codeRunsApi>
}
