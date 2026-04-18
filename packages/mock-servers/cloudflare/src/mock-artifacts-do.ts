type DurableObjectState = {
	storage: DurableObjectStorage
}

type DurableObjectEnv = Record<string, never>

type StoredMockArtifactRepo = {
	id: string
	name: string
	description: string | null
	default_branch: string
	created_at: string
	updated_at: string
	last_push_at: string | null
	source: string | null
	read_only: boolean
	remote: string
}

type MockArtifactsStorage = {
	repos: Record<string, StoredMockArtifactRepo>
}

type MockArtifactsListPayload = {
	limit: number
	cursor: string | null
}

type MockArtifactsGetPayload = {
	name: string
}

type MockArtifactsCreatePayload = {
	name: string
	description: string | null
	defaultBranch: string
	readOnly: boolean
	remote: string
}

type MockArtifactsForkPayload = {
	sourceName: string
	targetName: string
	readOnly: boolean
	remote: string
}

type MockArtifactsCreateTokenPayload = {
	repo: string
	scope: string
	ttl: number
}

type MockArtifactsCountPayload = Record<string, never>

type MockArtifactsCommand =
	| {
			type: 'list'
			payload: MockArtifactsListPayload
	  }
	| {
			type: 'get'
			payload: MockArtifactsGetPayload
	  }
	| {
			type: 'create'
			payload: MockArtifactsCreatePayload
	  }
	| {
			type: 'fork'
			payload: MockArtifactsForkPayload
	  }
	| {
			type: 'createToken'
			payload: MockArtifactsCreateTokenPayload
	  }
	| {
			type: 'count'
			payload: MockArtifactsCountPayload
	  }

function assertNever(value: never): never {
	throw new Error(`Unhandled mock artifacts command: ${String(value)}`)
}

export class MockCloudflareArtifactsDurableObject {
	readonly state: DurableObjectState

	constructor(state: DurableObjectState, _env: DurableObjectEnv) {
		this.state = state
	}

	async fetch(request: Request): Promise<Response> {
		let command: MockArtifactsCommand
		try {
			command = (await request.json()) as MockArtifactsCommand
		} catch {
			return new Response('Invalid JSON payload.', { status: 400 })
		}

		const storage = await this.readStorage()
		switch (command.type) {
			case 'list': {
				const repos = Object.values(storage.repos).sort((left, right) =>
					left.name.localeCompare(right.name),
				)
				const offset = Math.max(
					0,
					Number.parseInt(command.payload.cursor ?? '0', 10) || 0,
				)
				const limit = Math.max(1, command.payload.limit)
				const page = repos.slice(offset, offset + limit)
				const nextCursor =
					offset + limit < repos.length ? String(offset + limit) : null
				return Response.json({
					repos: page,
					total: repos.length,
					cursor: nextCursor,
				})
			}
			case 'get': {
				return Response.json({
					repo: storage.repos[command.payload.name] ?? null,
				})
			}
			case 'create': {
				if (storage.repos[command.payload.name]) {
					return Response.json({ error: 'repo_exists' })
				}
				const now = new Date().toISOString()
				const repo: StoredMockArtifactRepo = {
					id: `repo_${crypto.randomUUID()}`,
					name: command.payload.name,
					description: command.payload.description,
					default_branch: command.payload.defaultBranch,
					created_at: now,
					updated_at: now,
					last_push_at: null,
					source: null,
					read_only: command.payload.readOnly,
					remote: command.payload.remote,
				}
				storage.repos[repo.name] = repo
				await this.writeStorage(storage)
				return Response.json({ repo })
			}
			case 'fork': {
				const source = storage.repos[command.payload.sourceName]
				if (!source) {
					return Response.json({ error: 'repo_not_found' })
				}
				if (storage.repos[command.payload.targetName]) {
					return Response.json({ error: 'repo_exists' })
				}
				const now = new Date().toISOString()
				const repo: StoredMockArtifactRepo = {
					id: `repo_${crypto.randomUUID()}`,
					name: command.payload.targetName,
					description: source.description,
					default_branch: source.default_branch,
					created_at: now,
					updated_at: now,
					last_push_at: null,
					source: source.name,
					read_only: command.payload.readOnly,
					remote: command.payload.remote,
				}
				storage.repos[repo.name] = repo
				await this.writeStorage(storage)
				return Response.json({ repo })
			}
			case 'createToken': {
				const repo = storage.repos[command.payload.repo]
				if (!repo) {
					return Response.json({ error: 'repo_not_found' })
				}
				const expiresAtSeconds = Math.floor(Date.now() / 1000) + command.payload.ttl
				const tokenId = `tok_${crypto.randomUUID()}`
				return Response.json({
					token: {
						id: tokenId,
						plaintext: `${tokenId}?expires=${expiresAtSeconds}`,
						scope: command.payload.scope,
						expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
					},
				})
			}
			case 'count': {
				return Response.json({
					count: Object.keys(storage.repos).length,
				})
			}
			default:
				return assertNever(command)
		}
	}

	private async readStorage(): Promise<MockArtifactsStorage> {
		const storage = await this.state.storage.get<MockArtifactsStorage>('state')
		if (!storage) {
			return { repos: {} }
		}
		return {
			repos:
				storage.repos && typeof storage.repos === 'object' ? storage.repos : {},
		}
	}

	private async writeStorage(storage: MockArtifactsStorage) {
		await this.state.storage.put('state', storage)
	}
}

class MockCloudflareArtifactsState {
	private stub: DurableObjectStub

	constructor(stub: DurableObjectStub) {
		this.stub = stub
	}

	async countRepos() {
		const response = await this.callState<{ count: number }>({
			type: 'count',
			payload: {},
		})
		return response.count
	}

	async listRepos(limit: number, cursor: string | null) {
		return this.callState<{
			repos: Array<StoredMockArtifactRepo>
			total: number
			cursor: string | null
		}>({
			type: 'list',
			payload: { limit, cursor },
		})
	}

	async getRepo(name: string) {
		const response = await this.callState<{
			repo: StoredMockArtifactRepo | null
		}>({
			type: 'get',
			payload: { name },
		})
		return response.repo
	}

	async createRepo(input: MockArtifactsCreatePayload) {
		const response = await this.callState<{
			repo?: StoredMockArtifactRepo
			error?: string
		}>({
			type: 'create',
			payload: input,
		})
		if (!response.repo) {
			throw new Error(response.error ?? 'Failed to create mock artifacts repo.')
		}
		return response.repo
	}

	async forkRepo(input: MockArtifactsForkPayload) {
		const response = await this.callState<{
			repo?: StoredMockArtifactRepo
			error?: string
		}>({
			type: 'fork',
			payload: input,
		})
		if (!response.repo) {
			throw new Error(response.error ?? 'Failed to fork mock artifacts repo.')
		}
		return response.repo
	}

	async createToken(input: MockArtifactsCreateTokenPayload) {
		const response = await this.callState<{
			token?: {
				id: string
				plaintext: string
				scope: string
				expires_at: string
			}
			error?: string
		}>({
			type: 'createToken',
			payload: input,
		})
		if (!response.token) {
			throw new Error(
				response.error ?? 'Failed to create mock artifacts token.',
			)
		}
		return response.token
	}

	private async callState<TResponse>(
		payload: MockArtifactsCommand,
	): Promise<TResponse> {
		const response = await this.stub.fetch('https://mock-cloudflare-artifacts/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		})
		if (!response.ok) {
			const detail = await response.text()
			throw new Error(
				`Mock Cloudflare artifacts state failed (${response.status}): ${detail}`,
			)
		}
		return (await response.json()) as TResponse
	}
}

export function createMockCloudflareArtifactsState(stub: DurableObjectStub) {
	return new MockCloudflareArtifactsState(stub)
}
