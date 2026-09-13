import {
	type ConnectedMcpAgent,
	labelInboundMcpClient,
	oauthGrantCreatedAtIso,
} from '#universal/connected-mcp-agents.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import {
	forgetInboundMcpConnectionLastUsed,
	listInboundMcpConnectionLastUsed,
} from '#worker/inbound-mcp-connection-last-used.ts'
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
	options?: { env?: UserMeterEnv },
): Promise<InboundMcpConnectionState> {
	if (!helpers) {
		return { uniqueClientCount: 0, agents: [] }
	}
	try {
		const [grants, lastUsedByClientId] = await Promise.all([
			listUserOAuthGrants(helpers, userId),
			options?.env
				? listInboundMcpConnectionLastUsed({
						env: options.env,
						userId,
					}).catch(() => new Map<string, string>())
				: Promise.resolve(new Map<string, string>()),
		])
		return await labelInboundMcpGrants(helpers, grants, lastUsedByClientId)
	} catch {
		return { uniqueClientCount: 0, agents: [], listingFailed: true }
	}
}

export async function revokeConnectedMcpAgent(input: {
	helpers: OAuthGrantHelpers
	userId: string
	clientId: string
	env?: UserMeterEnv
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
	if (input.env) {
		await forgetInboundMcpConnectionLastUsed({
			env: input.env,
			userId: input.userId,
			clientId: input.clientId,
		}).catch(() => undefined)
	}
	return { revoked: grants.length }
}

async function labelInboundMcpGrants(
	helpers: OAuthGrantListHelpers,
	grants: Array<OAuthGrantListItem>,
	lastUsedByClientId: ReadonlyMap<string, string>,
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
			lastUsedAt: lastUsedByClientId.get(clientId) ?? null,
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
	const leftUsed = left.lastUsedAt ?? ''
	const rightUsed = right.lastUsedAt ?? ''
	if (leftUsed !== rightUsed) return rightUsed.localeCompare(leftUsed)
	const leftAt = left.connectedAt ?? ''
	const rightAt = right.connectedAt ?? ''
	if (leftAt !== rightAt) return rightAt.localeCompare(leftAt)
	return left.label.localeCompare(right.label)
}
