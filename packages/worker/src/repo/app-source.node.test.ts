import { expect, test, vi } from 'vitest'
import { type UiArtifactRow } from '#mcp/ui-artifacts-types.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	repoSessionRpc: vi.fn(),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('./repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mockModule.repoSessionRpc(...args),
}))

const { resolveSavedAppSource } = await import('./app-source.ts')

function createArtifact(): UiArtifactRow {
	return {
		id: 'app-1',
		user_id: 'user-1',
		title: 'Fallback app',
		description: 'Fallback source',
		sourceId: 'source-1',
		clientCode: '<main>fallback</main>',
		serverCode: 'export const fallback = true',
		serverCodeId: 'server-code-fallback',
		parameters: null,
		hidden: false,
		created_at: '2026-04-16T00:00:00.000Z',
		updated_at: '2026-04-16T00:00:00.000Z',
	}
}

test('resolveSavedAppSource rereads repo-backed sources instead of reusing module cache', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.repoSessionRpc.mockReset()

	let clientCode = '<main><h1>Version 1</h1></main>'
	let serverCode = 'export const version = 1'
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'session-1',
			source_id: 'source-1',
			source_root: '/',
			base_commit: 'commit-1',
			session_repo_id: 'session-repo-1',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-1',
			manifest_path: 'kody.json',
			entity_type: 'app' as const,
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'kody.json'
					? JSON.stringify({
							version: 1,
							kind: 'app',
							title: 'Repo-backed app',
							description: 'Resolves from repo',
							client: 'client.html',
							server: 'server.ts',
						})
					: path === 'client.html'
						? clientCode
						: serverCode,
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'session-1',
			deleted: true,
		})),
	}

	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'app',
		entity_id: 'app-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'kody.json',
		source_root: '/',
		created_at: '2026-04-16T00:00:00.000Z',
		updated_at: '2026-04-16T00:00:00.000Z',
	})
	mockModule.repoSessionRpc.mockReturnValue(sessionClient as never)

	const input = {
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		artifact: createArtifact(),
	}

	const first = await resolveSavedAppSource(input)
	clientCode = '<main><h1>Version 2</h1></main>'
	serverCode = 'export const version = 2'
	const second = await resolveSavedAppSource(input)

	expect(first).toMatchObject({
		title: 'Repo-backed app',
		description: 'Resolves from repo',
		clientCode: '<main><h1>Version 1</h1></main>',
		serverCode: 'export const version = 1',
		serverCodeId: 'commit-1',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
	})
	expect(second).toMatchObject({
		title: 'Repo-backed app',
		description: 'Resolves from repo',
		clientCode: '<main><h1>Version 2</h1></main>',
		serverCode: 'export const version = 2',
		serverCodeId: 'commit-1',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
	})
	expect(sessionClient.openSession).toHaveBeenCalledTimes(2)
	expect(sessionClient.discardSession).toHaveBeenCalledTimes(2)
})
