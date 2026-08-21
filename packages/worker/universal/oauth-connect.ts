import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'

export type ConnectOauthChooserKind = 'connection' | 'platform'

export type ConnectOauthChooserOption = {
	id: string
	href: string
	label: string
	detail: string
	providerKey: string
	logoPath: string | null
	kind: ConnectOauthChooserKind
}

export function isConnectOauthCallbackUrl(url: URL): boolean {
	return Boolean(url.searchParams.get('code') || url.searchParams.get('error'))
}

export function buildConnectOauthHref(input: {
	name: string
	platform?: boolean
	appSlug?: string
}): string {
	const params = new URLSearchParams({ provider: input.name })
	const appSlug = input.appSlug?.trim()
	if (input.platform) {
		params.set('platform', appSlug || '1')
	} else if (appSlug) {
		params.set('app', appSlug)
	}
	return `/connect/oauth?${params.toString()}`
}

export function buildConnectOauthChooserOptions(input: {
	connections: ReadonlyArray<{
		name: string
		label: string
		providerKey: string
		logoPath: string | null
		platform: boolean
		appSlug: string
		canDrive: boolean
	}>
	platformApps: ReadonlyArray<{
		slug: string
		label: string
		provider: string
		logoPath: string | null
	}>
}): Array<ConnectOauthChooserOption> {
	const takenNames = new Set(
		input.connections.map((connection) => connection.name),
	)
	const connectedPlatformSlugs = new Set(
		input.connections
			.filter((connection) => connection.platform)
			.map((connection) => connection.appSlug),
	)
	const connectionOptions = input.connections
		.filter((connection) => connection.canDrive)
		.map((connection) => {
			const providerKey =
				normalizeProviderKey(connection.providerKey) || connection.name
			return {
				id: `connection:${connection.name}`,
				href: buildConnectOauthHref({
					name: connection.name,
					platform: connection.platform,
					appSlug: connection.appSlug,
				}),
				label: connection.label,
				detail: connection.platform
					? 'Reconnect this built-in account'
					: 'Reconnect your OAuth app',
				providerKey,
				logoPath: connection.logoPath,
				kind: 'connection' as const,
			}
		})
	const platformOptions = input.platformApps
		.filter(
			(app) =>
				!takenNames.has(app.slug) && !connectedPlatformSlugs.has(app.slug),
		)
		.map((app) => {
			const providerKey = normalizeProviderKey(app.provider) || app.slug
			return {
				id: `platform:${app.slug}`,
				href: buildConnectOauthHref({
					name: app.slug,
					platform: true,
					appSlug: app.slug,
				}),
				label: app.label,
				detail: "Connect with Kody's built-in app",
				providerKey,
				logoPath: app.logoPath,
				kind: 'platform' as const,
			}
		})
	return [...connectionOptions, ...platformOptions]
}
