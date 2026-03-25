import {
	type JSONRPCErrorResponse,
	type JSONRPCMessage,
	type JSONRPCRequest,
	type JSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js'

export type HomeToolDescriptor = {
	name: string
	title?: string
	description?: string
	inputSchema?: Record<string, unknown>
	outputSchema?: Record<string, unknown>
	annotations?: Record<string, unknown>
	_meta?: Record<string, unknown>
}

export type HomeConnectorSnapshot = {
	connectorId: string
	connectedAt: string
	lastSeenAt: string
	tools: Array<HomeToolDescriptor>
}

export type HomeConnectorHelloMessage = {
	type: 'connector.hello'
	connectorId: string
	sharedSecret: string
}

export type HomeConnectorHeartbeatMessage = {
	type: 'connector.heartbeat'
}

export type HomeConnectorJsonRpcEnvelope = {
	type: 'connector.jsonrpc'
	message: JSONRPCMessage
}

export type HomeConnectorServerMessage =
	| HomeConnectorHelloMessage
	| HomeConnectorHeartbeatMessage
	| HomeConnectorJsonRpcEnvelope

export type HomeConnectorAckMessage = {
	type: 'server.ack'
	connectorId: string
}

export type HomeConnectorErrorMessage = {
	type: 'server.error'
	message: string
}

export type HomeConnectorPingMessage = {
	type: 'server.ping'
}

export type HomeConnectorClientMessage =
	| HomeConnectorAckMessage
	| HomeConnectorErrorMessage
	| HomeConnectorPingMessage

export type HomeConnectorPersistedState = {
	connectorId: string | null
	connectedAt: string | null
	lastSeenAt: string | null
}

export type HomeConnectorJsonRpcResponse =
	| JSONRPCResultResponse
	| JSONRPCErrorResponse

export type HomeConnectorJsonRpcRequest = JSONRPCRequest
