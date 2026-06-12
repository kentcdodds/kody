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

test('repo_write_file forwards write edits, optional flags, and empty content clears', async () => {
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

	const writeResult = await repoWriteFileCapability.handler(
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
	expect(writeResult).toEqual({
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

	const dryRunResult = await repoWriteFileCapability.handler(
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
	expect(dryRunResult.dry_run).toBe(true)
	expect(dryRunResult.total_changed).toBe(0)

	rpc.applyEdits.mockResolvedValueOnce({
		dryRun: false,
		totalChanged: 1,
		edits: [
			{ path: 'src/index.ts', changed: true, content: '', diff: '@@ cleared' },
		],
	})

	const clearResult = await repoWriteFileCapability.handler(
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
	expect(clearResult.total_changed).toBe(1)
})
