import {
	type ConnectedMcpAgent,
	labelInboundMcpClient,
	oauthGrantCreatedAtIso,
} from '#universal/connected-mcp-agents.ts'
import {
	listUserOAuthGrants,
	listUserOAuthGrantsForClient,
	revokeOAuthGrant,
	type OAuthClientInfo,
	type OAuthGrantHelpers,
	type OAuthGrantListHelpers,
	type OAuthGrantListItem,
} from '#worker/oauth-grants.ts'

export type ConnectedMcpAgentListItem = ConnectedMcpAgent & {
	grantIds: Array<string>
}

export type InboundMcpConnectionState = {
	uniqueClientCount: number
	agents: Array<ConnectedMcpAgentListItem>
	listingFailed?: boolean
}

export async function loadInboundMcpConnectionState(
	helpers: OAuthGrantListHelpers | undefined,
	userId: string,
): Promise<InboundMcpConnectionState> {
	if (!helpers) {
		return { uniqueClientCount: 0, agents: [] }
	}
	try {
		const grants = await listUserOAuthGrants(helpers, userId)
		return await labelInboundMcpGrants(helpers, grants)
	} catch {
		return { uniqueClientCount: 0, agents: [], listingFailed: true }
	}
}

export async function revokeConnectedMcpAgent(input: {
	helpers: OAuthGrantHelpers
	userId: string
	clientId: string
}): Promise<{ revoked: number } | { error: 'not_found' }> {
	const grants = await listUserOAuthGrantsForClient(
		input.helpers,
		input.userId,
		input.clientId,
	)
	if (grants.length === 0) return { error: 'not_found' }
	for (const grant of grants) {
		await revokeOAuthGrant(input.helpers, grant.id, input.userId)
	}
	return { revoked: grants.length }
}

async function labelInboundMcpGrants(
	helpers: OAuthGrantListHelpers,
	grants: Array<OAuthGrantListItem>,
): Promise<InboundMcpConnectionState> {
	const byClient = new Map<string, Array<OAuthGrantListItem>>()
	for (const grant of grants) {
		if (!grant.clientId) continue
		const existing = byClient.get(grant.clientId)
		if (existing) existing.push(grant)
		else byClient.set(grant.clientId, [grant])
	}

	const clientCache = new Map<string, OAuthClientInfo | null>()
	const agents = new Array<ConnectedMcpAgentListItem>()
	for (const [clientId, clientGrants] of byClient) {
		const client = await lookupClientBestEffort(helpers, clientCache, clientId)
		const labeled = labelInboundMcpClient({
			clientId,
			clientName: client?.clientName,
			redirectUris: client?.redirectUris,
			clientUri: client?.clientUri,
			grantRedirectUri: firstGrantRedirectUri(clientGrants),
		})
		agents.push({
			clientId,
			grantIds: clientGrants.map((grant) => grant.id),
			label: labeled.label,
			kind: labeled.kind,
			connectedAt: earliestGrantCreatedAt(clientGrants),
		})
	}

	agents.sort(compareConnectedAgents)
	return {
		uniqueClientCount: byClient.size,
		agents,
	}
}

async function lookupClientBestEffort(
	helpers: OAuthGrantListHelpers,
	cache: Map<string, OAuthClientInfo | null>,
	clientId: string,
): Promise<OAuthClientInfo | null> {
	if (cache.has(clientId)) return cache.get(clientId) ?? null
	if (!helpers.lookupClient) {
		cache.set(clientId, null)
		return null
	}
	try {
		const client = await helpers.lookupClient(clientId)
		cache.set(clientId, client)
		return client
	} catch {
		cache.set(clientId, null)
		return null
	}
}

function firstGrantRedirectUri(grants: Array<OAuthGrantListItem>) {
	for (const grant of grants) {
		if (grant.redirectUri) return grant.redirectUri
	}
	return undefined
}

function earliestGrantCreatedAt(grants: Array<OAuthGrantListItem>) {
	let earliest: number | undefined
	for (const grant of grants) {
		if (typeof grant.createdAt !== 'number') continue
		if (earliest === undefined || grant.createdAt < earliest) {
			earliest = grant.createdAt
		}
	}
	return oauthGrantCreatedAtIso(earliest)
}

function compareConnectedAgents(
	left: ConnectedMcpAgentListItem,
	right: ConnectedMcpAgentListItem,
) {
	const leftAt = left.connectedAt ?? ''
	const rightAt = right.connectedAt ?? ''
	if (leftAt !== rightAt) return rightAt.localeCompare(leftAt)
	return left.label.localeCompare(right.label)
}
