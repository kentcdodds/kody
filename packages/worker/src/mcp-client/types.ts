import { type Tool } from '@modelcontextprotocol/sdk/types.js'

export type McpServerConnectionState =
	| 'authenticating'
	| 'connecting'
	| 'connected'
	| 'discovering'
	| 'ready'
	| 'failed'
	| 'disconnected'

export type McpServerToolDescriptor = {
	name: string
	title?: string
	description?: string
	inputSchema: Tool['inputSchema']
	outputSchema?: Tool['outputSchema']
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
}
