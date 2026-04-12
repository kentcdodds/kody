import {
	type JSONRPCMessage,
	type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js'
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
	connectorIngressPath,
	connectorSessionKey,
} from '#worker/remote-connector/connector-session-key.ts'
import { type HomeConnectorJsonRpcResponse } from './types.ts'

export class HomeConnectorClientTransport implements Transport {
	sessionId?: string
	onclose?: () => void
	onerror?: (error: Error) => void
	onmessage?: <T extends JSONRPCMessage>(
		message: T,
		extra?: MessageExtraInfo,
	) => void

	private readonly input: {
		kind: string
		instanceId: string
		baseUrl: string
	}

	constructor(input: { kind?: string; instanceId: string; baseUrl: string }) {
		this.input = {
			kind: input.kind ?? 'home',
			instanceId: input.instanceId,
			baseUrl: input.baseUrl,
		}
	}

	async start(): Promise<void> {
		this.sessionId = connectorSessionKey(this.input.kind, this.input.instanceId)
	}

	async send(message: JSONRPCMessage): Promise<void> {
		try {
			const response = await this.forwardJsonRpc(message)
			if (response) {
				this.onmessage?.(response)
			}
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause))
			this.onerror?.(error)
			throw error
		}
	}

	async close(): Promise<void> {
		this.onclose?.()
	}

	private async forwardJsonRpc(
		message: JSONRPCMessage,
	): Promise<HomeConnectorJsonRpcResponse | null> {
		const path = `${connectorIngressPath(this.input.kind, this.input.instanceId)}/rpc/jsonrpc`
		const response = await fetch(`${this.input.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ message }),
		})
		if (!response.ok) {
			throw new Error(
				`Home connector bridge request failed with ${response.status}.`,
			)
		}
		return (await response.json()) as HomeConnectorJsonRpcResponse | null
	}
}
