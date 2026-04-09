type DurableObjectState = {
	storage: DurableObjectStorage
}

type DurableObjectEnv = Record<string, never>

const maxStoredMessages = 100

type StoredMockEmailMessage = {
	id: string
	token_hash: string
	received_at: number
	from_email: string
	to_json: string
	subject: string
	html: string
	text: string | null
	payload_json: string
}

type MockEmailMessageStoredPayload = {
	message: StoredMockEmailMessage
}

type MockEmailMessageListPayload = {
	limit: number
}

type MockEmailMessageGetPayload = {
	id: string
}

type MockEmailMessageClearPayload = Record<string, never>

type MockEmailMessageCountPayload = Record<string, never>

type MockEmailMessageCommand =
	| { type: 'store'; payload: MockEmailMessageStoredPayload }
	| { type: 'list'; payload: MockEmailMessageListPayload }
	| { type: 'get'; payload: MockEmailMessageGetPayload }
	| { type: 'clear'; payload: MockEmailMessageClearPayload }
	| { type: 'count'; payload: MockEmailMessageCountPayload }

type MockEmailMessageStorage = {
	totalCount: number
	recentMessages: Array<StoredMockEmailMessage>
}

export class MockCloudflareEmailMessagesDurableObject {
	readonly state: DurableObjectState

	constructor(state: DurableObjectState, _env: DurableObjectEnv) {
		this.state = state
	}

	async fetch(request: Request): Promise<Response> {
		let command: MockEmailMessageCommand
		try {
			command = (await request.json()) as MockEmailMessageCommand
		} catch {
			return new Response('Invalid JSON payload.', { status: 400 })
		}

		const storage = await this.readStorage()
		switch (command.type) {
			case 'store': {
				const { message } = command.payload
				storage.totalCount += 1
				storage.recentMessages.unshift(message)
				if (storage.recentMessages.length > maxStoredMessages) {
					storage.recentMessages.length = maxStoredMessages
				}
				await this.writeStorage(storage)
				return Response.json({ ok: true })
			}
			case 'list': {
				const { limit } = command.payload
				return Response.json({
					messages: storage.recentMessages.slice(0, limit),
				})
			}
			case 'get': {
				const { id } = command.payload
				return Response.json({
					message:
						storage.recentMessages.find((message) => message.id === id) ?? null,
				})
			}
			case 'count': {
				return Response.json({ count: storage.totalCount })
			}
			case 'clear': {
				await this.writeStorage({ totalCount: 0, recentMessages: [] })
				return Response.json({ ok: true })
			}
			default:
				return new Response('Unsupported request.', { status: 400 })
		}
	}

	private async readStorage(): Promise<MockEmailMessageStorage> {
		const storage =
			await this.state.storage.get<MockEmailMessageStorage>('state')
		if (!storage) {
			return { totalCount: 0, recentMessages: [] }
		}
		return {
			totalCount:
				typeof storage.totalCount === 'number' ? storage.totalCount : 0,
			recentMessages: Array.isArray(storage.recentMessages)
				? storage.recentMessages
				: [],
		}
	}

	private async writeStorage(storage: MockEmailMessageStorage) {
		await this.state.storage.put('state', storage)
	}
}

class MockCloudflareEmailState {
	private stub: DurableObjectStub

	constructor(stub: DurableObjectStub) {
		this.stub = stub
	}

	async addMessage(
		tokenHash: string,
		message: Omit<StoredMockEmailMessage, 'token_hash'>,
	) {
		await this.callState({
			type: 'store',
			payload: {
				message: {
					...message,
					token_hash: tokenHash,
				},
			},
		})
	}

	async countMessages() {
		const response = await this.callState<{ count: number }>({
			type: 'count',
			payload: {},
		})
		return response.count
	}

	async listMessages(limit: number) {
		const response = await this.callState<{
			messages: Array<StoredMockEmailMessage>
		}>({
			type: 'list',
			payload: { limit },
		})
		return response.messages
	}

	async getMessage(id: string) {
		const response = await this.callState<{
			message: StoredMockEmailMessage | null
		}>({
			type: 'get',
			payload: { id },
		})
		return response.message
	}

	async clearMessages() {
		await this.callState({ type: 'clear', payload: {} })
	}

	private async callState<TResponse>(
		payload: MockEmailMessageCommand,
	): Promise<TResponse> {
		const response = await this.stub.fetch('https://mock-cloudflare-email/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		})
		if (!response.ok) {
			const detail = await response.text()
			throw new Error(
				`Mock Cloudflare email state failed (${response.status}): ${detail}`,
			)
		}
		return (await response.json()) as TResponse
	}
}

export function createMockCloudflareEmailState(stub: DurableObjectStub) {
	return new MockCloudflareEmailState(stub)
}
