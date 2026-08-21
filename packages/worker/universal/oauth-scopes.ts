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
		`Load coding_guide_get({ guide: "oauth" }) and the matching provider_* guide if one exists.`,
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
	const allowed = uniqueOauthScopes(input.allowedScopes)
	const currentList =
		current.length > 0
			? current.map((scope) => `\`${scope}\``).join(', ')
			: 'none'
	const reconnectHref = `/connect/oauth?provider=${encodeURIComponent(name)}`
	if (input.platform) {
		const allowedList =
			allowed.length > 0
				? allowed.map((scope) => `\`${scope}\``).join(', ')
				: 'none'
		return [
			`The "${name}" connection is a built-in (platform) integration.`,
			`It currently requests these scopes: ${currentList}.`,
			`The operator-verified menu is: ${allowedList}.`,
			`Do not call integration_save to change authorization.scopes on a built-in — that capability refuses platform connections.`,
			`If the access I need is already on that menu, send me to ${reconnectHref} so I can check those scopes and reconnect.`,
			`If it is outside the menu, explain that I need a bring-your-own OAuth app and give me a complete /connect/oauth URL after loading the oauth and provider_* guides.`,
			`Make clear that updating stored scopes does not enlarge the current token until I reconnect.`,
		].join(' ')
	}
	return [
		`Add the scopes I need to the "${name}" OAuth integration.`,
		`authorization.scopes is reconnect metadata — the list the next /connect/oauth visit will request — not the current access token.`,
		`It currently requests: ${currentList}.`,
		`Load coding_guide_get({ guide: "oauth" }) and the matching provider_* guide.`,
		`Call integration_get / integration_list first. Scopes are per connection; sibling accounts that share an OAuth app keep their own scope lists.`,
		`Use integration_save to widen authorization.scopes on this connection only.`,
		`Then tell me in plain language that the saved integration now requests those scopes but existing tokens do not, and ask whether I want to reconnect this account (and any other accounts I name) at ${reconnectHref}.`,
	].join(' ')
}
