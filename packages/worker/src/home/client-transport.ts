import {
	type JSONRPCMessage,
	type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js'
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
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
		connectorId: string
		baseUrl: string
	}

	constructor(input: { connectorId: string; baseUrl: string }) {
		this.input = input
	}

	async start(): Promise<void> {
		this.sessionId = this.input.connectorId
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
		const response = await fetch(
			`${this.input.baseUrl}/home/connectors/${this.input.connectorId}/rpc/jsonrpc`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ message }),
			},
		)
		if (!response.ok) {
			throw new Error(
				`Home connector bridge request failed with ${response.status}.`,
			)
		}
		return (await response.json()) as HomeConnectorJsonRpcResponse | null
	}
}
