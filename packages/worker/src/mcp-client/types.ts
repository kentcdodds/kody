import { type JsonSchemaToolDescriptor } from '@cloudflare/codemode'
import { type Tool } from '@modelcontextprotocol/sdk/types.js'
import { type McpServerConnectionEvent } from './connection-episodes.ts'

export type McpServerConnectionState =
	| 'authenticating'
	| 'connecting'
	| 'connected'
	| 'discovering'
	| 'ready'
	| 'failed'
	| 'disconnected'

/**
 * Observable post-IdP settle stages. Names match handshake / discovery
 * methods this repo already uses.
 */
export type McpOAuthSettlePhase =
	| 'token exchange'
	| 'resource metadata'
	| 'mcp initialize'
	| 'server/discover'
	| 'tools/list'

export type McpServerLastError = {
	message: string
	phase: McpOAuthSettlePhase | null
	httpStatus: number | null
	httpBodySnippet: string | null
	mcpEndpoint: string | null
	resource: string | null
	authServer: string | null
	attemptId: string
	at: string
}

/**
 * Tool metadata from a connected MCP server.
 *
 * Schemas use codemode's JSON Schema shape (JSONSchema7) so they line up with
 * capability registration. Agents' `connection.tools` types are a looser
 * JSON-Schema-like inference from MCP SDK v1.30 / client v2 and are narrowed
 * at the hub mapping boundary.
 */
export type McpServerToolDescriptor = {
	name: string
	title?: string
	description?: string
	inputSchema: JsonSchemaToolDescriptor['inputSchema']
	outputSchema?: JsonSchemaToolDescriptor['outputSchema']
	annotations?: Tool['annotations']
}

export type McpServerSnapshot = {
	serverId: string
	name: string
	url: string
	state: McpServerConnectionState
	authUrl: string | null
	error: string | null
	instructions: string | null
	tools: Array<McpServerToolDescriptor>
}

export type McpClientHubSnapshot = {
	servers: Array<McpServerSnapshot>
	connectionEvents?: Array<McpServerConnectionEvent>
}

export type McpServerConnectResult = {
	serverId: string
	state: McpServerConnectionState
	authUrl: string | null
	error: string | null
	toolCount: number
}

export type McpServerOAuthCallbackOutcome = {
	serverId: string | null
	authSuccess: boolean
	authError: string | null
	serverName: string | null
	authorizationNeeded: boolean
	lastError: McpServerLastError | null
}
