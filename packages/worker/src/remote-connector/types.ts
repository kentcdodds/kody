import {
	type ConnectorHelloMessage,
	type ConnectorHeartbeatMessage,
	type ConnectorJsonRpcEnvelope,
	type ConnectorSnapshot,
	type ConnectorToolDescriptor,
	type KodyConnectorAckMessage,
	type KodyConnectorErrorMessage,
	type KodyConnectorPingMessage,
	type KodyToConnectorMessage,
} from '@kody-bot/connector-kit/protocol'
import {
	type JSONRPCErrorResponse,
	type JSONRPCMessage,
	type JSONRPCRequest,
	type JSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js'

export type RemoteConnectorToolDescriptor = ConnectorToolDescriptor

export type RemoteConnectorSnapshot = ConnectorSnapshot

export type RemoteConnectorHelloMessage = ConnectorHelloMessage

export type RemoteConnectorHeartbeatMessage = ConnectorHeartbeatMessage

export type RemoteConnectorJsonRpcEnvelope = Omit<
	ConnectorJsonRpcEnvelope,
	'message'
> & {
	message: JSONRPCMessage
}

export type RemoteConnectorServerMessage =
	| RemoteConnectorHelloMessage
	| RemoteConnectorHeartbeatMessage
	| RemoteConnectorJsonRpcEnvelope

export type RemoteConnectorAckMessage = KodyConnectorAckMessage

export type RemoteConnectorErrorMessage = KodyConnectorErrorMessage

export type RemoteConnectorPingMessage = KodyConnectorPingMessage

export type RemoteConnectorClientMessage = KodyToConnectorMessage

export type RemoteConnectorPersistedState = {
	connectorId: string | null
	description: string | null
	connectedAt: string | null
	lastSeenAt: string | null
}

export type RemoteConnectorSessionExport = {
	persisted: RemoteConnectorPersistedState
	tools: Array<RemoteConnectorToolDescriptor>
	connected: boolean
}

export type RemoteConnectorJsonRpcResponse =
	| JSONRPCResultResponse
	| JSONRPCErrorResponse

export type RemoteConnectorJsonRpcRequest = JSONRPCRequest
