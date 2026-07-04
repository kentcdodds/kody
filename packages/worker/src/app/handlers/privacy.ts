import { type Action } from 'remix/router'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createPrivacyHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return renderAppPage({
				request,
				env,
				title: 'Privacy',
			})
		},
	} satisfies Action<typeof routes.privacy>
}
