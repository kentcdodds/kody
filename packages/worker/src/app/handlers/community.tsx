/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type RemixNode } from 'remix/ui'
import { type Action } from 'remix/router'
import { loadCommunityIndexData } from '#app/community-data.ts'
import { CommunityIndexOgHead } from '#app/ssr-document.tsx'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createCommunityHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const community = await loadCommunityIndexData(env, request.url)
			return renderAppPage({
				request,
				env,
				title: 'Community packages',
				extraHead: (<CommunityIndexOgHead />) as RemixNode,
				loaderData: { community },
			})
		},
	} satisfies Action<typeof routes.community>
}

export { createCommunityApiHandler } from '#app/community-api.ts'
