type DurableObjectState = {
	storage: DurableObjectStorage
}

type DurableObjectEnv = Record<string, never>

const MAX_STORED_MESSAGES = 100

type StoredMockMessage = {
	id: string
	token_hash: string
	received_at: number
	from_email: string
	to_json: string
	subject: string
	html: string
	payload_json: string
}

type MockMessageStoredPayload = {
	message: StoredMockMessage
}

type MockMessageListPayload = {
	limit: number
}

type MockMessageGetPayload = {
	id: string
}

type MockMessageClearPayload = Record<string, never>

type MockMessageCountPayload = Record<string, never>

type MockMessageMessage =
	| { type: 'store'; payload: MockMessageStoredPayload }
	| { type: 'list'; payload: MockMessageListPayload }
	| { type: 'get'; payload: MockMessageGetPayload }
	| { type: 'clear'; payload: MockMessageClearPayload }
	| { type: 'count'; payload: MockMessageCountPayload }

type MockMessageStorage = {
	totalCount: number
	recentMessages: Array<StoredMockMessage>
}

export class MockResendMessagesDurableObject {
	readonly state: DurableObjectState

	constructor(state: DurableObjectState, _env: DurableObjectEnv) {
		this.state = state
	}

	async fetch(request: Request): Promise<Response> {
		let message: MockMessageMessage
		try {
			message = (await request.json()) as MockMessageMessage
		} catch {
			return new Response('Invalid JSON payload.', { status: 400 })
		}

		const storage = await this.readStorage()
		switch (message.type) {
			case 'store': {
				const { message: stored } = message.payload
				storage.totalCount += 1
				storage.recentMessages.unshift(stored)
				if (storage.recentMessages.length > MAX_STORED_MESSAGES) {
					storage.recentMessages.length = MAX_STORED_MESSAGES
				}
				await this.writeStorage(storage)
				return Response.json({ ok: true })
			}
			case 'list': {
				const { limit } = message.payload
				return Response.json({
					messages: storage.recentMessages.slice(0, limit),
				})
			}
			case 'get': {
				const { id } = message.payload
				const list = storage.recentMessages
				return Response.json({
					message: list.find((item) => item.id === id) ?? null,
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

	private async readStorage(): Promise<MockMessageStorage> {
		const storage = await this.state.storage.get<
			MockMessageStorage | { messagesByToken?: Record<string, Array<StoredMockMessage>> }
		>('state')
		if (!storage) {
			return { totalCount: 0, recentMessages: [] }
		}
		if ('messagesByToken' in storage && storage.messagesByToken) {
			const legacyMessages = Object.values(storage.messagesByToken)[0] ?? []
			return {
				totalCount: legacyMessages.length,
				recentMessages: legacyMessages.slice(0, MAX_STORED_MESSAGES),
			}
		}
		if ('totalCount' in storage || 'recentMessages' in storage) {
			return {
				totalCount:
					'totalCount' in storage && typeof storage.totalCount === 'number'
						? storage.totalCount
						: 0,
				recentMessages:
					'recentMessages' in storage && Array.isArray(storage.recentMessages)
						? storage.recentMessages
						: [],
			}
		}
		return { totalCount: 0, recentMessages: [] }
	}

	private async writeStorage(storage: MockMessageStorage) {
		await this.state.storage.put('state', storage)
	}
}

class MockResendState {
	private stub: DurableObjectStub

	constructor(stub: DurableObjectStub) {
		this.stub = stub
	}

	async addMessage(
		tokenHash: string,
		message: Omit<StoredMockMessage, 'token_hash'>,
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
			messages: Array<StoredMockMessage>
		}>({
			type: 'list',
			payload: { limit },
		})
		return response.messages
	}

	async getMessage(id: string) {
		const response = await this.callState<{
			message: StoredMockMessage | null
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
		payload: MockMessageMessage,
	): Promise<TResponse> {
		const response = await this.stub.fetch('https://mock-resend-state/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		})
		if (!response.ok) {
			const detail = await response.text()
			throw new Error(
				`Mock Resend state failed (${response.status}): ${detail}`,
			)
		}
		return (await response.json()) as TResponse
	}
}

export function createMockResendState(stub: DurableObjectStub) {
	return new MockResendState(stub)
}
