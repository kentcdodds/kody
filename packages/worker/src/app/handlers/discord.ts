import { type Action } from 'remix/router'
import { jsonResponse } from '#worker/json-response.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadDiscordPageData } from '#app/discord-page-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

async function loadDiscordPageForRequest(input: {
	env: Env
	request: Request
}) {
	const user = await readAuthenticatedAppUser(input.request, input.env)
	return loadDiscordPageData({
		env: input.env,
		userId: user?.userId,
	})
}

export function createDiscordHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return renderAppPage({
				request,
				env,
				loaderData: {
					discord: await loadDiscordPageForRequest({ env, request }),
				},
			})
		},
	} satisfies Action<typeof routes.discord>
}

export function createDiscordApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return jsonResponse(await loadDiscordPageForRequest({ env, request }))
		},
	} satisfies Action<typeof routes.discordApi>
}
