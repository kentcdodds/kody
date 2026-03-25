import {
	type JSONRPCMessage,
	type JSONRPCRequest,
	type JSONRPCResponse,
} from '@modelcontextprotocol/sdk/types.js'
import {
	type HomeConnectorAckMessage,
	type HomeConnectorHelloMessage,
	type HomeConnectorClientMessage,
	type HomeConnectorJsonRpcEnvelope,
} from '../../../worker/src/home/types.ts'
import { stringifyHomeConnectorMessage } from '../../../worker/src/home/utils.ts'
import { type HomeConnectorConfig } from '../config.ts'
import { type HomeConnectorState, updateConnectionState } from '../state.ts'
import { type HomeConnectorToolRegistry } from '../mcp/server.ts'

const heartbeatIntervalMs = 10_000
const reconnectDelayMs = 2_000

function isJsonRpcResponse(
	message: JSONRPCMessage,
): message is JSONRPCResponse {
	return 'id' in message && ('result' in message || 'error' in message)
}

function isJsonRpcRequest(message: JSONRPCMessage): message is JSONRPCRequest {
	return 'id' in message && 'method' in message
}

function isAckMessage(
	message: HomeConnectorClientMessage,
): message is HomeConnectorAckMessage {
	return message.type === 'server.ack'
}

function isJsonRpcEnvelope(
	message: HomeConnectorClientMessage | HomeConnectorJsonRpcEnvelope,
): message is HomeConnectorJsonRpcEnvelope {
	return message.type === 'connector.jsonrpc'
}

function createToolsChangedNotification(): JSONRPCMessage {
	return {
		jsonrpc: '2.0',
		method: 'notifications/tools/list_changed',
	}
}

async function handleJsonRpcRequest(
	message: JSONRPCRequest,
	toolRegistry: HomeConnectorToolRegistry,
) {
	if (message.method === 'tools/list') {
		return {
			jsonrpc: '2.0',
			id: message.id,
			result: {
				tools: toolRegistry.list(),
			},
		} satisfies JSONRPCResponse
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
			} satisfies JSONRPCResponse
		}

		try {
			const result = await toolRegistry.call(name, params.arguments ?? {})
			return {
				jsonrpc: '2.0',
				id: message.id,
				result,
			} satisfies JSONRPCResponse
		} catch (error: unknown) {
			return {
				jsonrpc: '2.0',
				id: message.id,
				error: {
					code: -32000,
					message: error instanceof Error ? error.message : String(error),
				},
			} satisfies JSONRPCResponse
		}
	}

	return {
		jsonrpc: '2.0',
		id: message.id,
		error: {
			code: -32601,
			message: `Connector request handling is not implemented for ${message.method}.`,
		},
	} satisfies JSONRPCResponse
}

export function createWorkerConnector(input: {
	config: HomeConnectorConfig
	state: HomeConnectorState
	toolRegistry: HomeConnectorToolRegistry
}) {
	let started = false
	let stopped = false
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	let socket: WebSocket | null = null

	const heartbeat = setInterval(() => {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(
				stringifyHomeConnectorMessage({
					type: 'connector.heartbeat',
				}),
			)
		}
	}, heartbeatIntervalMs)

	function clearReconnectTimer() {
		if (!reconnectTimer) return
		clearTimeout(reconnectTimer)
		reconnectTimer = null
	}

	function scheduleReconnect() {
		if (stopped || reconnectTimer) return
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null
			connect()
		}, reconnectDelayMs)
	}

	function connect() {
		if (stopped || !input.config.sharedSecret) {
			return
		}
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			return
		}
		clearReconnectTimer()
		updateConnectionState(input.state, {
			connected: false,
			lastError: null,
		})
		socket = new WebSocket(input.config.workerWebSocketUrl)

		socket.addEventListener('open', () => {
			const hello: HomeConnectorHelloMessage = {
				type: 'connector.hello',
				connectorId: input.config.homeConnectorId,
				sharedSecret: input.config.sharedSecret!,
			}
			socket?.send(stringifyHomeConnectorMessage(hello))
		})

		socket.addEventListener('message', async (event) => {
			const value = JSON.parse(String(event.data)) as
				| HomeConnectorClientMessage
				| HomeConnectorJsonRpcEnvelope
			switch (value.type) {
				case 'server.ping':
					updateConnectionState(input.state, {
						lastSyncAt: new Date().toISOString(),
						lastError: null,
					})
					return
				case 'server.error':
					updateConnectionState(input.state, {
						connected: false,
						lastError: value.message,
					})
					console.error(`Home connector error: ${value.message}`)
					return
				case 'server.ack':
					updateConnectionState(input.state, {
						connected: true,
						lastSyncAt: new Date().toISOString(),
						lastError: null,
					})
					if (isAckMessage(value) && socket?.readyState === WebSocket.OPEN) {
						socket.send(
							stringifyHomeConnectorMessage({
								type: 'connector.jsonrpc',
								message: createToolsChangedNotification(),
							}),
						)
					}
					return
				case 'connector.jsonrpc': {
					const message = value.message
					if (isJsonRpcEnvelope(value) && isJsonRpcResponse(message)) {
						updateConnectionState(input.state, {
							lastSyncAt: new Date().toISOString(),
							lastError: null,
						})
						return
					}
					if (
						isJsonRpcEnvelope(value) &&
						isJsonRpcRequest(message) &&
						socket?.readyState === WebSocket.OPEN
					) {
						const response = await handleJsonRpcRequest(
							message,
							input.toolRegistry,
						)
						socket.send(
							stringifyHomeConnectorMessage({
								type: 'connector.jsonrpc',
								message: response,
							}),
						)
						updateConnectionState(input.state, {
							lastSyncAt: new Date().toISOString(),
							lastError: null,
						})
					}
				}
			}
		})

		socket.addEventListener('close', () => {
			updateConnectionState(input.state, {
				connected: false,
			})
			console.warn('Home connector websocket closed.')
			socket = null
			scheduleReconnect()
		})

		socket.addEventListener('error', (event) => {
			updateConnectionState(input.state, {
				connected: false,
				lastError: 'Home connector websocket error.',
			})
			console.error('Home connector websocket error', event)
		})
	}

	return {
		async start() {
			if (started) return
			started = true
			if (!input.config.sharedSecret) {
				updateConnectionState(input.state, {
					connected: false,
					lastError:
						'Connector registration is disabled because HOME_CONNECTOR_SHARED_SECRET is not set. Start from the repo root with `bun run dev` or provide the secret manually.',
				})
				return
			}
			connect()
		},
		stop() {
			stopped = true
			clearReconnectTimer()
			clearInterval(heartbeat)
			socket?.close()
			socket = null
		},
	}
}
