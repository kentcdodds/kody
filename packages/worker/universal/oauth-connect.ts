import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'

export type ConnectOauthChooserKind = 'connection'

export type ConnectOauthChooserOption = {
	id: string
	href: string
	label: string
	detail: string
	providerKey: string
	logoPath: string | null
	autoLogoPath: string | null
	catalogLogoPath: string | null
	kind: ConnectOauthChooserKind
}

export function isConnectOauthCallbackUrl(url: URL): boolean {
	return Boolean(url.searchParams.get('code') || url.searchParams.get('error'))
}

export function buildConnectOauthHref(input: {
	name: string
	appSlug?: string
}): string {
	const params = new URLSearchParams({ provider: input.name })
	const appSlug = input.appSlug?.trim()
	if (appSlug) {
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
		autoLogoPath: string | null
		catalogLogoPath: string | null
		platform: boolean
		appSlug: string
		canDrive: boolean
	}>
}): Array<ConnectOauthChooserOption> {
	return input.connections
		.filter((connection) => connection.canDrive)
		.map((connection) => {
			const providerKey =
				normalizeProviderKey(connection.providerKey) || connection.name
			return {
				id: `connection:${connection.name}`,
				href: buildConnectOauthHref({
					name: connection.name,
					// Existing platform connections stay listed so the owner
					// can migrate, but the href is a bring-your-own reconnect
					// (no `app=` that would look like a built-in slug).
					appSlug: connection.platform ? undefined : connection.appSlug,
				}),
				label: connection.label,
				detail: connection.platform
					? 'Set up your own OAuth app to reconnect'
					: 'Reconnect your OAuth app',
				providerKey,
				logoPath: connection.logoPath,
				autoLogoPath: connection.autoLogoPath,
				catalogLogoPath: connection.catalogLogoPath,
				kind: 'connection' as const,
			}
		})
}
