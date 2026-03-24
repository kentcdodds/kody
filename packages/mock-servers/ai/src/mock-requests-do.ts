type StoredMockRequest = {
	id: string
	token_hash: string
	received_at: number
	scenario: string
	last_user_message: string
	tool_names_json: string
	request_json: string
	response_text: string
}

type DurableObjectState = {
	storage: DurableObjectStorage
}

type DurableObjectEnv = Record<string, never>

type MockAiStateMessage =
	| { action: 'append'; request: StoredMockRequest }
	| { action: 'list'; limit: number }
	| { action: 'count' }
	| { action: 'clear' }

type MockAiStateStorage = {
	requests: Array<StoredMockRequest>
}

export class MockAiState {
	readonly #state: DurableObjectState

	constructor(state: DurableObjectState, _env: DurableObjectEnv) {
		this.#state = state
	}

	async fetch(request: Request): Promise<Response> {
		let message: MockAiStateMessage
		try {
			message = (await request.json()) as MockAiStateMessage
		} catch {
			return new Response('Invalid JSON payload.', { status: 400 })
		}

		const storage = await this.readStorage()
		switch (message.action) {
			case 'append': {
				storage.requests.unshift(message.request)
				await this.writeStorage(storage)
				return Response.json({ ok: true })
			}
			case 'list': {
				const result = storage.requests.slice(0, message.limit)
				return Response.json({ requests: result })
			}
			case 'count': {
				return Response.json({ count: storage.requests.length })
			}
			case 'clear': {
				await this.writeStorage({ requests: [] })
				return Response.json({ ok: true })
			}
			default:
				return new Response('Unsupported request.', { status: 400 })
		}
	}

	private async readStorage(): Promise<MockAiStateStorage> {
		const storage = await this.#state.storage.get<MockAiStateStorage>('state')
		return storage ?? { requests: [] }
	}

	private async writeStorage(storage: MockAiStateStorage) {
		await this.#state.storage.put('state', storage)
	}
}
