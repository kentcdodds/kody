import {
	buildConnectOauthChooserOptions,
	type ConnectOauthChooserOption,
} from '#universal/oauth-connect.ts'
import { buildPlatformOauthAppLogoPath } from '#worker/integrations/platform-app-logo.ts'
import {
	listAvailablePlatformApps,
	listJoinedIntegrations,
} from '#worker/integrations/service.ts'

export type { ConnectOauthChooserOption }

export async function loadConnectOauthChooser(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<{ options: Array<ConnectOauthChooserOption> }> {
	const [joined, platformApps] = await Promise.all([
		listJoinedIntegrations({ env: input.env, userId: input.userId }),
		listAvailablePlatformApps({ env: input.env }),
	])
	return {
		options: buildConnectOauthChooserOptions({
			connections: joined.map((entry) => ({
				name: entry.connection.name,
				label:
					entry.connection.accountLabel?.trim() ||
					entry.app.label?.trim() ||
					entry.connection.name,
				providerKey: entry.app.provider,
				logoPath:
					entry.lane === 'platform'
						? buildPlatformOauthAppLogoPath(entry.app)
						: null,
				platform: entry.lane === 'platform',
				appSlug: entry.app.slug,
				canDrive: Boolean(
					entry.app.authorizeUrl?.trim() && entry.app.tokenUrl.trim(),
				),
			})),
			platformApps: platformApps.map((app) => ({
				slug: app.slug,
				label: app.label?.trim() || app.slug,
				provider: app.provider,
				logoPath: buildPlatformOauthAppLogoPath(app),
			})),
		}),
	}
}
