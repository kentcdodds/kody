import { type Action } from 'remix/router'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import { findWithAgent } from '#universal/with-agents.ts'

export function createWithAgentHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (!findWithAgent(params.agent)) {
				return renderAppPage({
					request,
					env,
					title: 'Agent not found',
					notFound: true,
					status: 404,
				})
			}
			return renderAppPage({ request, env })
		},
	} satisfies Action<typeof routes.withAgent>
}
