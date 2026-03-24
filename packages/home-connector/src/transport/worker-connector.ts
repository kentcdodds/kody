import {
	type JSONRPCMessage,
	type JSONRPCRequest,
	type JSONRPCResponse,
} from '@modelcontextprotocol/sdk/types.js'
import {
	type HomeConnectorHelloMessage,
	type HomeConnectorServerMessage,
} from '../../../worker/src/home/types.ts'
import { stringifyHomeConnectorMessage } from '../../../worker/src/home/utils.ts'
import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorToolRegistry } from '../mcp/server.ts'

function isJsonRpcResponse(message: JSONRPCMessage): message is JSONRPCResponse {
	return 'id' in message && ('result' in message || 'error' in message)
}

function isJsonRpcRequest(message: JSONRPCMessage): message is JSONRPCRequest {
	return 'id' in message && 'method' in message
}

export function startWorkerConnector(input: {
	config: HomeConnectorConfig
	toolRegistry: HomeConnectorToolRegistry
}) {
	const ws = new WebSocket(input.config.workerWebSocketUrl)
	const pendingResponses = new Map<
		string | number,
		(message: JSONRPCResponse) => void
	>()

	ws.addEventListener('open', () => {
		const hello: HomeConnectorHelloMessage = {
			type: 'connector.hello',
			connectorId: input.config.connectorId,
			sharedSecret: input.config.sharedSecret,
		}
		ws.send(stringifyHomeConnectorMessage(hello))
	})

	ws.addEventListener('message', async (event) => {
		const value = JSON.parse(String(event.data)) as HomeConnectorServerMessage
		switch (value.type) {
			case 'server.ack':
			case 'server.ping':
				return
			case 'server.error':
				console.error(`Home connector error: ${value.message}`)
				return
			case 'connector.jsonrpc': {
				const message = value.message
				if (isJsonRpcResponse(message)) {
					const pending = pendingResponses.get(message.id)
					if (!pending) return
					pendingResponses.delete(message.id)
					pending(message)
					return
				}
				if (isJsonRpcRequest(message)) {
					const response = handleJsonRpcRequest(message, input.toolRegistry)
					ws.send(
						stringifyHomeConnectorMessage({
							type: 'connector.jsonrpc',
							message: response,
						}),
					)
					return
				}
			}
		}
	})

	ws.addEventListener('close', () => {
		console.warn('Home connector websocket closed.')
	})

	ws.addEventListener('error', (event) => {
		console.error('Home connector websocket error', event)
	})

	const heartbeat = setInterval(() => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(
				stringifyHomeConnectorMessage({
					type: 'connector.heartbeat',
				}),
			)
		}
	}, 10_000)

	return {
		ws,
		heartbeat,
		toolRegistry: input.toolRegistry,
	}
}

function handleJsonRpcRequest(
	message: JSONRPCRequest,
	toolRegistry: HomeConnectorToolRegistry,
): JSONRPCResponse {
	if (message.method === 'tools/list') {
		return {
			jsonrpc: '2.0',
			id: message.id,
			result: {
				tools: toolRegistry.list(),
			},
		}
	}

	if (message.method === 'tools/call') {
		const params = (message.params ?? {}) as {
			name?: string
			arguments?: Record<string, unknown>
		}
		const name = params.name?.trim()
		if (!name) {
			return {
				jsonrpc: '2.0',
				id: message.id,
				error: {
					code: -32602,
					message: 'Missing tool name.',
				},
			}
		}

		const tool = toolRegistry.get(name)
		if (!tool) {
			return {
				jsonrpc: '2.0',
				id: message.id,
				error: {
					code: -32601,
					message: `Unknown tool: ${name}.`,
				},
			}
		}

		void params
		const promise = tool
			.handler((message.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {})
			.then((result) => ({
				jsonrpc: '2.0',
				id: message.id,
				result,
			}))
			.catch((error: unknown) => ({
				jsonrpc: '2.0',
				id: message.id,
				error: {
					code: -32000,
					message: error instanceof Error ? error.message : String(error),
				},
			}))

		// Bun's WebSocket message callback can be async, so the caller awaits this.
		return promise as unknown as JSONRPCResponse
	}

	return {
		jsonrpc: '2.0',
		id: message.id,
		error: {
			code: -32601,
			message: `Connector request handling is not implemented for ${message.method}.`,
		},
	}
}
