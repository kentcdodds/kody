export type StoredMockRequest = {
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

const MAX_STORED_REQUESTS = 100

export type MockAiStateMessage =
	| { action: 'append'; request: StoredMockRequest }
	| { action: 'list'; limit: number }
	| { action: 'count' }
	| { action: 'clear' }

type MockAiStateStorage = {
	totalCount: number
	recentRequests: Array<StoredMockRequest>
}

export class MockAiState {
	readonly state: DurableObjectState

	constructor(state: DurableObjectState, _env: DurableObjectEnv) {
		this.state = state
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
				storage.totalCount += 1
				storage.recentRequests.unshift(message.request)
				if (storage.recentRequests.length > MAX_STORED_REQUESTS) {
					storage.recentRequests.length = MAX_STORED_REQUESTS
				}
				await this.writeStorage(storage)
				return Response.json({ ok: true })
			}
			case 'list': {
				const result = storage.recentRequests.slice(0, message.limit)
				return Response.json({ requests: result })
			}
			case 'count': {
				return Response.json({ count: storage.totalCount })
			}
			case 'clear': {
				await this.writeStorage({ totalCount: 0, recentRequests: [] })
				return Response.json({ ok: true })
			}
			default:
				return new Response('Unsupported request.', { status: 400 })
		}
	}

	private async readStorage(): Promise<MockAiStateStorage> {
		const storage = await this.state.storage.get<
			MockAiStateStorage | { requests?: Array<StoredMockRequest> }
		>('state')
		if (!storage) {
			return { totalCount: 0, recentRequests: [] }
		}
		if ('requests' in storage && Array.isArray(storage.requests)) {
			return {
				totalCount: storage.requests.length,
				recentRequests: storage.requests.slice(0, MAX_STORED_REQUESTS),
			}
		}
		if ('totalCount' in storage || 'recentRequests' in storage) {
			return {
				totalCount:
					'totalCount' in storage && typeof storage.totalCount === 'number'
						? storage.totalCount
						: 0,
				recentRequests:
					'recentRequests' in storage && Array.isArray(storage.recentRequests)
						? storage.recentRequests
						: [],
			}
		}
		return { totalCount: 0, recentRequests: [] }
	}

	private async writeStorage(storage: MockAiStateStorage) {
		await this.state.storage.put('state', storage)
	}
}
