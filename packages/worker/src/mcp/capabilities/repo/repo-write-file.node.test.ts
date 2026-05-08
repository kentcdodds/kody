import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

const { repoWriteFileCapability } = await import('./repo-write-file.ts')

function createCapabilityContext() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-1', email: 'user@example.com' },
		}),
	}
}

function createRpc(overrides?: Partial<Record<string, unknown>>) {
	return {
		applyEdits: vi.fn(),
		...overrides,
	}
}

function resetMocks() {
	mockModule.repoSessionRpc.mockReset()
}

test('repo_write_file forwards write edits to applyEdits and reshapes the response', async () => {
	resetMocks()
	const rpc = createRpc()
	rpc.applyEdits.mockResolvedValueOnce({
		dryRun: false,
		totalChanged: 2,
		edits: [
			{
				path: 'src/index.ts',
				changed: true,
				content: 'export const value = 1\n',
				diff: '@@ diff a',
			},
			{
				path: 'README.md',
				changed: true,
				content: '# README\n',
				diff: '@@ diff b',
			},
		],
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoWriteFileCapability.handler(
		{
			session_id: 'session-1',
			files: [
				{ path: 'src/index.ts', content: 'export const value = 1\n' },
				{ path: 'README.md', content: '# README\n' },
			],
		},
		createCapabilityContext(),
	)

	expect(mockModule.repoSessionRpc).toHaveBeenCalledWith(
		expect.anything(),
		'session-1',
	)
	expect(rpc.applyEdits).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: 'user-1',
		edits: [
			{
				kind: 'write',
				path: 'src/index.ts',
				content: 'export const value = 1\n',
			},
			{ kind: 'write', path: 'README.md', content: '# README\n' },
		],
		dryRun: undefined,
		rollbackOnError: undefined,
	})
	expect(result).toEqual({
		dry_run: false,
		total_changed: 2,
		edits: [
			{
				path: 'src/index.ts',
				changed: true,
				content: 'export const value = 1\n',
				diff: '@@ diff a',
			},
			{
				path: 'README.md',
				changed: true,
				content: '# README\n',
				diff: '@@ diff b',
			},
		],
	})
})

test('repo_write_file passes dry_run and rollback_on_error through to applyEdits', async () => {
	resetMocks()
	const rpc = createRpc()
	rpc.applyEdits.mockResolvedValueOnce({
		dryRun: true,
		totalChanged: 0,
		edits: [
			{
				path: 'src/index.ts',
				changed: false,
				content: 'unchanged\n',
				diff: '',
			},
		],
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoWriteFileCapability.handler(
		{
			session_id: 'session-1',
			files: [{ path: 'src/index.ts', content: 'unchanged\n' }],
			dry_run: true,
			rollback_on_error: false,
		},
		createCapabilityContext(),
	)

	expect(rpc.applyEdits).toHaveBeenCalledWith(
		expect.objectContaining({
			dryRun: true,
			rollbackOnError: false,
		}),
	)
	expect(result.dry_run).toBe(true)
	expect(result.total_changed).toBe(0)
})

test('repo_write_file rejects an empty files array via input schema', async () => {
	resetMocks()
	const rpc = createRpc()
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	await expect(
		repoWriteFileCapability.handler(
			{ session_id: 'session-1', files: [] },
			createCapabilityContext(),
		),
	).rejects.toThrow()
	expect(rpc.applyEdits).not.toHaveBeenCalled()
})

test('repo_write_file requires non-empty paths', async () => {
	resetMocks()
	const rpc = createRpc()
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	await expect(
		repoWriteFileCapability.handler(
			{
				session_id: 'session-1',
				files: [{ path: '', content: 'hello' }],
			},
			createCapabilityContext(),
		),
	).rejects.toThrow()
	expect(rpc.applyEdits).not.toHaveBeenCalled()
})

test('repo_write_file allows empty content for clearing a file', async () => {
	resetMocks()
	const rpc = createRpc()
	rpc.applyEdits.mockResolvedValueOnce({
		dryRun: false,
		totalChanged: 1,
		edits: [
			{ path: 'src/index.ts', changed: true, content: '', diff: '@@ cleared' },
		],
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	const result = await repoWriteFileCapability.handler(
		{
			session_id: 'session-1',
			files: [{ path: 'src/index.ts', content: '' }],
		},
		createCapabilityContext(),
	)
	expect(rpc.applyEdits).toHaveBeenCalledWith(
		expect.objectContaining({
			edits: [{ kind: 'write', path: 'src/index.ts', content: '' }],
		}),
	)
	expect(result.total_changed).toBe(1)
})
