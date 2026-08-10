import { type AccountMcpServersLoaderData } from '#universal/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	buildMcpServerStatusView,
	loadMcpClientHubSnapshotOrNull,
} from '#mcp/capabilities/mcp-servers/shared.ts'
import {
	listMcpServerSettings,
	resolveMcpServerOAuthClientUrls,
} from '#worker/mcp-client/settings-service.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function loadAccountMcpServersData(input: {
	env: Env
	user: AuthenticatedUser
	requestUrl?: string | URL | null
}): Promise<AccountMcpServersLoaderData> {
	const userId = input.user.mcpUser.userId
	const oauth = resolveMcpServerOAuthClientUrls({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const settings = await listMcpServerSettings({ env: input.env, userId })
	const snapshot =
		settings.length > 0
			? await loadMcpClientHubSnapshotOrNull({ env: input.env, userId })
			: null
	return {
		ok: true,
		email: input.user.email,
		username: input.user.username,
		oauthClientOrigin: oauth.clientOrigin,
		oauthCallbackUrl: oauth.callbackUrl,
		servers: settings.map((setting) =>
			buildMcpServerStatusView({
				setting,
				snapshot:
					snapshot?.servers.find((server) => server.serverId === setting.id) ??
					null,
				oauthCallbackUrl: oauth.callbackUrl,
				oauthClientOrigin: oauth.clientOrigin,
			}),
		),
	}
}
