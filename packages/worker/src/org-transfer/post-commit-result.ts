import { buildMcpServerAuthorizeUrl } from '#worker/mcp-client/authorize-consent.ts'
import { isAuthorizationPending } from '#worker/mcp-client/hub-client.ts'
import {
	type McpHubConnectResult,
	type McpServerConnectionState,
} from '#worker/mcp-client/types.ts'
import { type OrgTransferFinding } from './findings.ts'

/**
 * A moved MCP server after the target hub dialed it. `state` is null when
 * the connect step failed (see the matching post-commit warning).
 * `authorize_url` is the Kody consent page, never the provider URL.
 */
export type OrgTransferMcpConnection = {
	id: string
	name: string
	state: McpServerConnectionState | null
	needs_authorization: boolean
	authorize_url: string | null
}

export type OrgTransferPostCommitResult = {
	leftovers: Record<string, number>
	warnings: Array<OrgTransferFinding>
	mcpConnections: Array<OrgTransferMcpConnection>
}

export function describeOrgTransferMcpConnection(input: {
	serverId: string
	name: string
	result: McpHubConnectResult | null
	appOrigin: string
	toSlug: string
}): OrgTransferMcpConnection {
	const needsAuthorization = input.result
		? isAuthorizationPending(input.result)
		: false
	return {
		id: input.serverId,
		name: input.name,
		state: input.result?.state ?? null,
		needs_authorization: needsAuthorization,
		authorize_url: needsAuthorization
			? buildMcpServerAuthorizeUrl({
					appOrigin: input.appOrigin,
					orgSlug: input.toSlug,
					serverId: input.serverId,
				})
			: null,
	}
}
