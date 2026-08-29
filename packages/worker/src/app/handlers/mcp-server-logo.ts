import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadFittedMcpServerLogo } from '#worker/mcp-client/mcp-server-logo.ts'
import { getMcpServerSettingById } from '#worker/mcp-client/settings-service.ts'
import { type routes } from '#universal/routes.ts'

/**
 * Serving route for user-added MCP server favicons. Requires a signed-in
 * session and resolves the caller's server so one user cannot read another
 * user's stored mark.
 */
export function createMcpServerLogoHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return new Response('Not found', { status: 404 })
			}
			const server = await getMcpServerSettingById({
				env,
				userId: user.mcpUser.userId,
				id: params.serverId,
			})
			if (!server?.logoKey) {
				return new Response('Not found', { status: 404 })
			}
			const logo = await loadFittedMcpServerLogo({
				db: env.APP_DB,
				env,
				userId: user.mcpUser.userId,
				serverId: server.id,
				logoKey: server.logoKey,
				logoContentType: server.logoContentType,
				logoSource: server.logoSource,
				faviconSourceHost: server.faviconSourceHost,
			})
			if (!logo) {
				return new Response('Not found', { status: 404 })
			}
			return new Response(logo.body, {
				headers: {
					'Cache-Control': logo.cacheControl,
					'Content-Length': String(logo.size),
					'Content-Type': logo.contentType,
					ETag: logo.httpEtag,
					'X-Content-Type-Options': 'nosniff',
				},
			})
		},
	} satisfies Action<typeof routes.accountMcpServerLogo>
}
