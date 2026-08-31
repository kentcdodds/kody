import {
	buildConnectOauthChooserOptions,
	type ConnectOauthChooserOption,
} from '#universal/oauth-connect.ts'
import { buildPlatformOauthAppLogoPath } from '#worker/integrations/platform-app-logo.ts'
import {
	listPlatformProviderMarks,
	resolveProviderMarkLogoPath,
	hostFromProviderUrl,
} from '#worker/integrations/provider-marks.ts'
import { buildUserOauthAppLogoPaths } from '#worker/integrations/user-oauth-app-logo.ts'
import {
	listAvailablePlatformApps,
	listJoinedIntegrations,
} from '#worker/integrations/service.ts'

export type { ConnectOauthChooserOption }

export async function loadConnectOauthChooser(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<{ options: Array<ConnectOauthChooserOption> }> {
	const [joined, platformApps, marks] = await Promise.all([
		listJoinedIntegrations({ env: input.env, userId: input.userId }),
		listAvailablePlatformApps({ env: input.env }),
		listPlatformProviderMarks({ db: input.env.APP_DB }),
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
						: buildUserOauthAppLogoPaths(entry.app).logoPath,
				autoLogoPath:
					entry.lane === 'platform'
						? null
						: buildUserOauthAppLogoPaths(entry.app).autoLogoPath,
				catalogLogoPath: resolveProviderMarkLogoPath({
					marks,
					providerKey: entry.app.provider,
					host: hostFromProviderUrl(entry.app.authorizeUrl),
				}),
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
				catalogLogoPath: resolveProviderMarkLogoPath({
					marks,
					providerKey: app.provider,
					host: hostFromProviderUrl(app.authorizeUrl),
				}),
			})),
		}),
	}
}
