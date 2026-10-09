import {
	buildPlatformConnectOauthHref,
	selectConnectablePlatformApps,
	type ConnectablePlatformApp,
	type PlatformIntegrationCatalogItem,
} from '#universal/oauth-connect.ts'
import { buildPlatformOauthAppLogoPath } from '#worker/integrations/platform-app-logo.ts'
import {
	listPlatformProviderMarks,
	resolveProviderMarkLogoPath,
	hostFromProviderUrl,
	type PlatformProviderMark,
} from '#worker/integrations/provider-marks.ts'
import {
	listAvailablePlatformApps,
	listJoinedIntegrations,
	type PlatformOauthApp,
} from '#worker/integrations/service.ts'

/**
 * Onboarding Step 2 featured built-ins, in display order. A slug still has to
 * be published (and enabled) to appear; listing it here never surfaces a draft.
 */
export const onboardingFeaturedPlatformIntegrationSlugs = [
	'github-platform',
	'google-platform',
	'notion-platform',
	'slack-platform',
] as const

export function toConnectablePlatformApp(
	app: PlatformOauthApp,
	marks: ReadonlyArray<PlatformProviderMark>,
): ConnectablePlatformApp {
	return {
		slug: app.slug,
		label: app.label?.trim() || app.slug,
		provider: app.provider,
		logoPath: buildPlatformOauthAppLogoPath(app),
		catalogLogoPath: resolveProviderMarkLogoPath({
			marks,
			providerKey: app.provider,
			host: hostFromProviderUrl(app.authorizeUrl),
		}),
	}
}

/**
 * Discoverable (enabled + published) built-ins the viewer can still newly
 * connect, for the account integrations page and onboarding. `order`, when
 * given, is an allowlist: only listed slugs appear, in that order. Fails open
 * to an empty catalog so a D1 blip never breaks the host page.
 */
export async function loadPlatformIntegrationCatalog(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string | null
	order?: ReadonlyArray<string>
}): Promise<Array<PlatformIntegrationCatalogItem>> {
	try {
		const [platformApps, joined, marks] = await Promise.all([
			listAvailablePlatformApps({ env: input.env }),
			input.userId
				? listJoinedIntegrations({ env: input.env, userId: input.userId })
				: Promise.resolve([]),
			listPlatformProviderMarks({ db: input.env.APP_DB }),
		])
		const connectable = selectConnectablePlatformApps({
			platformApps,
			connections: joined.map((entry) => ({
				name: entry.connection.name,
				platform: entry.lane === 'platform',
				appSlug: entry.app.slug,
			})),
		})
		const ordered = input.order
			? input.order.flatMap((slug) => {
					const app = connectable.find((entry) => entry.slug === slug)
					return app ? [app] : []
				})
			: connectable
		return ordered.map((app) => ({
			...toConnectablePlatformApp(app, marks),
			description: app.description,
			connectHref: buildPlatformConnectOauthHref(app.slug),
		}))
	} catch {
		return []
	}
}
