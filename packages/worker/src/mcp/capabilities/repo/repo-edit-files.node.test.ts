import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

const { repoEditFilesCapability } = await import('./repo-edit-files.ts')

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

test('repo_edit_files forwards batch edits including delete and move', async () => {
	mockModule.repoSessionRpc.mockReset()
	const rpc = createRpc()
	rpc.applyEdits.mockResolvedValueOnce({
		dryRun: false,
		totalChanged: 3,
		edits: [
			{
				path: 'src/index.ts',
				changed: true,
				content: 'updated\n',
				diff: '@@ a',
			},
			{
				path: 'src/remove.ts',
				changed: true,
				content: '',
				diff: '@@ b',
			},
			{
				path: 'src/new.ts',
				changed: true,
				content: 'moved\n',
				diff: '@@ c',
			},
		],
	})
	mockModule.repoSessionRpc.mockReturnValue(rpc)

	const result = await repoEditFilesCapability.handler(
		{
			session_id: 'session-1',
			edits: [
				{ kind: 'write', path: 'src/index.ts', content: 'updated\n' },
				{ kind: 'delete', path: 'src/remove.ts' },
				{ kind: 'move', path: 'src/old.ts', to: 'src/new.ts' },
			],
			dry_run: true,
			rollback_on_error: false,
		},
		createCapabilityContext(),
	)

	expect(rpc.applyEdits).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: 'user-1',
		edits: [
			{ kind: 'write', path: 'src/index.ts', content: 'updated\n' },
			{ kind: 'delete', path: 'src/remove.ts' },
			{ kind: 'move', path: 'src/old.ts', to: 'src/new.ts' },
		],
		dryRun: true,
		rollbackOnError: false,
	})
	expect(result.total_changed).toBe(3)
	expect(result.dry_run).toBe(false)
})
