/**
 * Turn opaque third-party OAuth/AS errors into actionable guidance when Kody
 * is the MCP *client* (user-added servers).
 *
 * Providers such as FusionAuth reject authorize requests whose browser
 * Origin/Referer is not on an authorized-origins allowlist. Reviewed-client
 * hosts (Vercel MCP) reject Kody's redirect URI until they approve the
 * client. Both are configured on the remote authorization server, not in
 * Kody.
 */

const vercelMcpSupportedClientsUrl =
	'https://vercel.com/docs/agent-resources/vercel-mcp'
const vercelMcpAllowlistIssueUrl =
	'https://github.com/kentcdodds/kody/issues/1986'

const mcpOAuthAllowlistFailureHeadline =
	'The remote authorization server rejected Kody as an unapproved OAuth client (allowlist / redirect URI).'

type McpOAuthProviderErrorUrls = {
	callbackUrl: string
	clientOrigin: string
	clientMetadataUrl?: string | null
	serverUrl?: string | null
}

export type McpOAuthAllowlistFailure = {
	kind: 'allowlist'
	headline: string
	callbackUrl: string
	clientOrigin: string
	providerMessage: string
	guidance: string
	vercelDocsUrl: string | null
	vercelIssueUrl: string | null
}

type McpOAuthProviderErrorDescription =
	| McpOAuthAllowlistFailure
	| { kind: 'atlassian'; message: string }
	| { kind: 'other'; message: string }

function isVercelMcpServerUrl(url: string | null | undefined) {
	if (!url) return false
	try {
		const host = new URL(url).hostname.toLowerCase()
		return host === 'mcp.vercel.com' || host.endsWith('.mcp.vercel.com')
	} catch {
		return false
	}
}

function isVercelMcpAllowlistMessage(message: string) {
	const lower = message.toLowerCase()
	return (
		lower.includes('vercel has not approved kody') ||
		lower.includes('vercel.com/docs/agent-resources/vercel-mcp') ||
		lower.includes('github.com/kentcdodds/kody/issues/1986')
	)
}

export function isMcpOAuthAllowlistRejection(message: string) {
	const lower = message.trim().toLowerCase()
	if (!lower) return false
	if (lower.includes('unapproved oauth client')) return true
	return looksLikeOriginRejection(lower) || looksLikeRedirectRejection(lower)
}

export function describeMcpOAuthProviderError(
	message: string,
	input: McpOAuthProviderErrorUrls,
): McpOAuthProviderErrorDescription {
	const trimmed = message.trim()
	if (!trimmed) return { kind: 'other', message: trimmed }

	const lower = trimmed.toLowerCase()
	if (
		lower.includes('supported sites required') ||
		lower.includes('not currently associated with a supported site')
	) {
		return {
			kind: 'atlassian',
			message: [
				trimmed,
				'Atlassian Rovo MCP needs a Jira or Confluence Cloud site on the account you authorize. A site-less Atlassian account cannot finish this connect.',
			].join(' '),
		}
	}

	if (!isMcpOAuthAllowlistRejection(trimmed)) {
		return { kind: 'other', message: trimmed }
	}

	const vercel =
		isVercelMcpServerUrl(input.serverUrl) ||
		isVercelMcpAllowlistMessage(trimmed)
	const cimd = input.clientMetadataUrl
		? ` Also allowlist this CIMD client_id: ${input.clientMetadataUrl}.`
		: ''
	const guidance = vercel
		? `Vercel has not approved Kody as an MCP client yet. See Vercel's supported clients (${vercelMcpSupportedClientsUrl}) and tracking issue ${vercelMcpAllowlistIssueUrl}.`
		: `If you operate this MCP server (or its identity provider), allow Kody's origin ${input.clientOrigin} and register that exact redirect URI.${cimd} Then reconnect the server in Kody so authorization uses the allowlisted values.`

	return {
		kind: 'allowlist',
		headline: mcpOAuthAllowlistFailureHeadline,
		callbackUrl: input.callbackUrl,
		clientOrigin: input.clientOrigin,
		providerMessage: extractProviderMessage(trimmed),
		guidance,
		vercelDocsUrl: vercel ? vercelMcpSupportedClientsUrl : null,
		vercelIssueUrl: vercel ? vercelMcpAllowlistIssueUrl : null,
	}
}

function formatMcpOAuthProviderError(
	described: McpOAuthProviderErrorDescription,
) {
	if (described.kind !== 'allowlist') return described.message
	const parts = [
		described.headline,
		`Kody used this callback URL: ${described.callbackUrl}.`,
		described.guidance,
	]
	if (described.providerMessage) {
		parts.push(`Provider message: ${described.providerMessage}`)
	}
	return parts.join(' ')
}

export function enrichMcpOAuthProviderError(
	message: string,
	input: McpOAuthProviderErrorUrls,
) {
	return formatMcpOAuthProviderError(
		describeMcpOAuthProviderError(message, input),
	)
}

function looksLikeOriginRejection(lower: string) {
	return (
		lower.includes('invalid origin') ||
		lower.includes('unauthorized origin') ||
		lower.includes('origin uri') ||
		lower.includes('authorized origin')
	)
}

function looksLikeRedirectRejection(lower: string) {
	return (
		lower.includes('invalid redirect') ||
		lower.includes('redirect_uri') ||
		lower.includes('redirect uri')
	)
}

function extractProviderMessage(trimmed: string) {
	const providerPrefix = 'Provider message: '
	if (trimmed.startsWith(mcpOAuthAllowlistFailureHeadline)) {
		const idx = trimmed.lastIndexOf(providerPrefix)
		if (idx === -1) return ''
		return trimmed.slice(idx + providerPrefix.length).trim()
	}
	return trimmed
}
