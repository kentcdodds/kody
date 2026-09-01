import { type AccountMcpServersLoaderData } from '#universal/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	buildMcpServerStatusView,
	loadMcpClientHubSnapshotOrNull,
} from '#mcp/capabilities/mcp-servers/shared.ts'
import {
	attachCatalogLogoPath,
	listPlatformProviderMarks,
} from '#worker/integrations/provider-marks.ts'
import { backfillMissingMcpServerFavicons } from '#worker/mcp-client/mcp-server-favicon.ts'
import { buildMcpServerAutoLogoPath } from '#worker/mcp-client/mcp-server-logo.ts'
import {
	listMcpServerSettings,
	resolveMcpServerOAuthClientUrls,
} from '#worker/mcp-client/settings-service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function loadAccountMcpServersData(input: {
	env: Env
	user: AuthenticatedUser
	requestUrl?: string | URL | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<AccountMcpServersLoaderData> {
	const userId = input.user.mcpUser.userId
	const oauth = resolveMcpServerOAuthClientUrls({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const [settings, savedPackages, marks] = await Promise.all([
		listMcpServerSettings({ env: input.env, userId }),
		listSavedPackagesByUserId(input.env.APP_DB, { userId }),
		listPlatformProviderMarks({ db: input.env.APP_DB }),
	])
	await backfillMissingMcpServerFavicons({
		db: input.env.APP_DB,
		env: input.env,
		userId,
		servers: settings,
		waitUntil: input.waitUntil,
	})
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
		oauthClientMetadataUrl: oauth.clientMetadataUrl,
		servers: settings.map((setting) =>
			attachCatalogLogoPath(
				{
					...buildMcpServerStatusView({
						setting,
						snapshot:
							snapshot?.servers.find(
								(server) => server.serverId === setting.id,
							) ?? null,
						oauthCallbackUrl: oauth.callbackUrl,
						oauthClientOrigin: oauth.clientOrigin,
						oauthClientMetadataUrl: oauth.clientMetadataUrl,
					}),
					autoLogoPath: buildMcpServerAutoLogoPath(setting),
				},
				marks,
			),
		),
		savedPackages: savedPackages.map((entry) => ({
			id: entry.id,
			kodyId: entry.kodyId,
		})),
	}
}
