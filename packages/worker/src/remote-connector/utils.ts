import {
	type RemoteConnectorClientMessage,
	type RemoteConnectorServerMessage,
} from './types.ts'
import {
	parseConnectorMessage,
	stringifyConnectorMessage,
} from '@kody-bot/connector-kit/protocol'
import { type JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'

export function parseRemoteConnectorMessage(
	raw: string | ArrayBuffer,
): RemoteConnectorServerMessage {
	return parseConnectorMessage(raw) as RemoteConnectorServerMessage
}

export function stringifyRemoteConnectorMessage(
	message: RemoteConnectorServerMessage | RemoteConnectorClientMessage,
) {
	return stringifyConnectorMessage(
		message as Parameters<typeof stringifyConnectorMessage>[0],
	)
}

export function createJsonRpcRequest(
	id: string,
	method: string,
	params: Record<string, unknown>,
): JSONRPCRequest {
	return {
		jsonrpc: '2.0',
		id,
		method,
		params,
	}
}
