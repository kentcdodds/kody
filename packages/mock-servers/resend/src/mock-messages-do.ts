type MockMessageRecord = {
	id: string
	received_at: number
	from_email: string
	to_json: string
	subject: string
	html: string
	payload_json: string
}

type DurableObjectState = {
	storage: DurableObjectStorage
}

type DurableObjectEnv = Record<string, never>

type MockMessageStoredPayload = {
	message: MockMessageRecord
}

type MockMessageListPayload = {
	tokenHash: string
	limit: number
}

type MockMessageGetPayload = {
	tokenHash: string
	id: string
}

type MockMessageClearPayload = {
	tokenHash: string
}

type MockMessageCountPayload = {
	tokenHash: string
}

type MockMessageMessage =
	| { type: 'store'; payload: MockMessageStoredPayload }
	| { type: 'list'; payload: MockMessageListPayload }
	| { type: 'get'; payload: MockMessageGetPayload }
	| { type: 'clear'; payload: MockMessageClearPayload }
	| { type: 'count'; payload: MockMessageCountPayload }

type MockMessageStorage = {
	messagesByToken: Record<string, Array<MockMessageRecord>>
}

export class MockResendMessagesDurableObject {
	readonly #state: DurableObjectState

	constructor(state: DurableObjectState, _env: DurableObjectEnv) {
		this.#state = state
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
				const list = storage.messagesByToken[stored.token_hash] ?? []
				list.unshift(stored)
				storage.messagesByToken[stored.token_hash] = list
				await this.writeStorage(storage)
				return Response.json({ ok: true })
			}
			case 'list': {
				const { tokenHash, limit } = message.payload
				const list = storage.messagesByToken[tokenHash] ?? []
				return Response.json({ messages: list.slice(0, limit) })
			}
			case 'get': {
				const { tokenHash, id } = message.payload
				const list = storage.messagesByToken[tokenHash] ?? []
				return Response.json({
					message: list.find((item) => item.id === id) ?? null,
				})
			}
			case 'count': {
				const { tokenHash } = message.payload
				const list = storage.messagesByToken[tokenHash] ?? []
				return Response.json({ count: list.length })
			}
			case 'clear': {
				const { tokenHash } = message.payload
				storage.messagesByToken[tokenHash] = []
				await this.writeStorage(storage)
				return Response.json({ ok: true })
			}
			default:
				return new Response('Unsupported request.', { status: 400 })
		}
	}

	private async readStorage(): Promise<MockMessageStorage> {
		const storage = await this.#state.storage.get<MockMessageStorage>('state')
		return storage ?? { messagesByToken: {} }
	}

	private async writeStorage(storage: MockMessageStorage) {
		await this.#state.storage.put('state', storage)
	}
}

type StoredMockMessage = {
	id: string
	received_at: number
	from_email: string
	to_json: string
	subject: string
	html: string
	payload_json: string
}

class MockResendState {
	constructor(private stub: DurableObjectStub) {}

	async addMessage(tokenHash: string, message: StoredMockMessage) {
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

	async countMessages(tokenHash: string) {
		const response = await this.callState<{ count: number }>({
			type: 'count',
			payload: { tokenHash },
		})
		return response.count
	}

	async listMessages(tokenHash: string, limit: number) {
		const response = await this.callState<{
			messages: Array<StoredMockMessage>
		}>({
			type: 'list',
			payload: { tokenHash, limit },
		})
		return response.messages
	}

	async getMessage(tokenHash: string, id: string) {
		const response = await this.callState<{
			message: StoredMockMessage | null
		}>({
			type: 'get',
			payload: { tokenHash, id },
		})
		return response.message
	}

	async clearMessages(tokenHash: string) {
		await this.callState({ type: 'clear', payload: { tokenHash } })
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
