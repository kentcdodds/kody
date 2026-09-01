import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'

/**
 * Shared OAuth scope-menu helpers for the connect page and account
 * integrations UI. "Selected" is the requested list stored on a connection;
 * "allowed" is the operator-verified platform menu when one exists.
 */

export function uniqueOauthScopes(
	scopes: ReadonlyArray<string> | null | undefined,
): Array<string> {
	const seen = new Set<string>()
	const result: Array<string> = []
	for (const raw of scopes ?? []) {
		const scope = raw.trim()
		if (!scope || seen.has(scope)) continue
		seen.add(scope)
		result.push(scope)
	}
	return result
}

/**
 * Built-in menu first, then any already-selected scopes that are not on it
 * (query overrides / older grants). Bring-your-own connections have no menu,
 * so the selected list is the whole list.
 */
export function resolveOauthScopeMenu(input: {
	allowedScopes?: ReadonlyArray<string> | null
	selectedScopes: ReadonlyArray<string> | null | undefined
}): Array<string> {
	const selected = uniqueOauthScopes(input.selectedScopes)
	const allowed = uniqueOauthScopes(input.allowedScopes)
	if (allowed.length === 0) return selected
	return [...allowed, ...selected.filter((scope) => !allowed.includes(scope))]
}

export function formatOauthScopeDisclosureLabel(input: {
	selectedCount: number
	menuCount: number
}): string {
	const noun = input.selectedCount === 1 ? 'scope' : 'scopes'
	if (input.menuCount > input.selectedCount) {
		return `Change ${noun} (${input.selectedCount} of ${input.menuCount})`
	}
	return `Change the ${input.selectedCount} ${noun}`
}

export function formatOauthScopeSummary(input: {
	selectedCount: number
	menuCount: number
}): string {
	if (input.menuCount > input.selectedCount && input.menuCount > 0) {
		return `${input.selectedCount} of ${input.menuCount} scopes`
	}
	const noun = input.selectedCount === 1 ? 'scope' : 'scopes'
	return `${input.selectedCount} ${noun}`
}

export function buildIncompleteConnectOauthPrompt(input: {
	provider: string
}): string {
	const providerKey = normalizeProviderKey(input.provider)
	const provider = providerKey || 'this provider'
	const href = providerKey
		? `/connect/oauth?provider=${encodeURIComponent(providerKey)}`
		: '/connect/oauth'
	return [
		`I opened ${href} to connect "${provider}" to my Kody account, but Kody does not have enough OAuth configuration to start the flow (missing authorize URL and/or token URL).`,
		`Open search({ entity: "oauth:guide" }) and, if a provider guide exists, search({ entity: "provider_<slug>:guide" }).`,
		`Then give me a complete /connect/oauth URL with the required query parameters (provider, authorizeUrl, tokenUrl, and any scopes, flow, and allowedHosts the provider needs) so I can connect.`,
	].join(' ')
}

export function buildChangeIntegrationScopesPrompt(input: {
	name: string
	platform: boolean
	currentScopes: ReadonlyArray<string> | null | undefined
	allowedScopes?: ReadonlyArray<string> | null
}): string {
	const name = input.name.trim() || 'this'
	const current = uniqueOauthScopes(input.currentScopes)
	const currentList =
		current.length > 0
			? current.map((scope) => `\`${scope}\``).join(', ')
			: 'none'
	const reconnectHref = `/connect/oauth?provider=${encodeURIComponent(name)}`
	if (input.platform) {
		return [
			`The "${name}" connection is a built-in (platform) integration that is being retired.`,
			`It currently requests these scopes: ${currentList}.`,
			`Do not call integration_save to change authorization.scopes on a built-in — that capability refuses platform connections.`,
			`To change access or reconnect, set up a bring-your-own OAuth app at ${reconnectHref} (or a complete /connect/oauth URL after opening oauth:guide and the matching provider_<slug>:guide).`,
			`Reconnecting replaces this built-in connection with the user's own app. Existing tokens stay valid until then.`,
		].join(' ')
	}
	return [
		`Add the scopes I need to the "${name}" OAuth integration.`,
		`authorization.scopes is reconnect metadata — the list the next /connect/oauth visit will request — not the current access token.`,
		`It currently requests: ${currentList}.`,
		`Open search({ entity: "oauth:guide" }) and, if a provider guide exists, search({ entity: "provider_<slug>:guide" }).`,
		`Call integration_get / integration_list first. Scopes are per connection; sibling accounts that share an OAuth app keep their own scope lists.`,
		`Use integration_save to widen authorization.scopes on this connection only.`,
		`Then tell me in plain language that the saved integration now requests those scopes but existing tokens do not, and ask whether I want to reconnect this account (and any other accounts I name) at ${reconnectHref}.`,
	].join(' ')
}
