import {
	type HomeConnectorClientMessage,
	type HomeConnectorJsonRpcEnvelope,
	type HomeConnectorServerMessage,
} from './types.ts'
import {
	type JSONRPCErrorResponse,
	type JSONRPCMessage,
	type JSONRPCRequest,
	type JSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js'

export function jsonResponse(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...init?.headers,
		},
	})
}

export function isJsonRpcEnvelope(
	value: HomeConnectorServerMessage,
): value is HomeConnectorJsonRpcEnvelope {
	return value.type === 'connector.jsonrpc'
}

export function parseHomeConnectorMessage(
	raw: string | ArrayBuffer,
): HomeConnectorServerMessage {
	const text =
		typeof raw === 'string' ? raw : new TextDecoder().decode(new Uint8Array(raw))
	const value = JSON.parse(text) as unknown
	if (!value || typeof value !== 'object') {
		throw new Error('Expected object message.')
	}
	const type = (value as Record<string, unknown>)['type']
	if (type === 'connector.hello') {
		const connectorId = (value as Record<string, unknown>)['connectorId']
		const sharedSecret = (value as Record<string, unknown>)['sharedSecret']
		if (typeof connectorId !== 'string' || typeof sharedSecret !== 'string') {
			throw new Error('Invalid connector hello payload.')
		}
		return {
			type,
			connectorId,
			sharedSecret,
		}
	}
	if (type === 'connector.heartbeat') {
		return { type }
	}
	if (type === 'connector.jsonrpc') {
		const message = (value as Record<string, unknown>)['message']
		if (!message || typeof message !== 'object') {
			throw new Error('Invalid JSON-RPC envelope payload.')
		}
		return {
			type,
			message: message as HomeConnectorJsonRpcEnvelope['message'],
		}
	}
	throw new Error(`Unknown home connector message type: ${String(type)}`)
}

export function stringifyHomeConnectorMessage(
	message: HomeConnectorServerMessage | HomeConnectorClientMessage,
) {
	return JSON.stringify(message)
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

export function createJsonRpcResultResponse(
	id: string | number,
	result: Record<string, unknown>,
): JSONRPCResultResponse {
	return {
		jsonrpc: '2.0',
		id,
		result,
	}
}

export function createJsonRpcErrorResponse(
	id: string | number | undefined,
	code: number,
	message: string,
): JSONRPCErrorResponse {
	return {
		jsonrpc: '2.0',
		id,
		error: {
			code,
			message,
		},
	}
}

export function parseJsonRpcMessage(message: JSONRPCMessage) {
	return message
}

