import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mocks.repoSessionRpc(...args),
}))

const { repoTreeCapability } = await import('./repo-tree.ts')

function createContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-alice',
				email: 'alice@example.com',
				displayName: 'Alice',
			},
		}),
	}
}

test('repo_tree maps missing-path ENOENT to McpCallerError', async () => {
	const tree = vi
		.fn()
		.mockRejectedValue(
			Object.assign(
				new Error('ENOENT: no such file or directory: /session/docs'),
				{ code: 'ENOENT' },
			),
		)
	mocks.repoSessionRpc.mockReturnValue({ tree })

	const error = await repoTreeCapability
		.handler(
			{
				session_id: 'session-1',
				path: 'docs',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).toMatchObject({
		message: 'Path "docs" was not found in the repo session workspace.',
	})
	expect(tree).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: 'user-alice',
		path: 'docs',
		maxDepth: undefined,
	})
})

test('repo_tree maps ENOENT errors in a cause chain to McpCallerError', async () => {
	const missingPathError = Object.assign(
		new Error('ENOENT: no such file or directory: /session/tests'),
		{ code: 'ENOENT' },
	)
	const tree = vi.fn().mockRejectedValue(
		Object.assign(new Error('Repository tree RPC failed.'), {
			cause: missingPathError,
		}),
	)
	mocks.repoSessionRpc.mockReturnValue({ tree })

	const error = await repoTreeCapability
		.handler(
			{
				session_id: 'session-1',
				path: 'tests',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).toMatchObject({
		message: 'Path "tests" was not found in the repo session workspace.',
	})
	expect(tree).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: 'user-alice',
		path: 'tests',
		maxDepth: undefined,
	})
})

test('repo_tree still surfaces non-ENOENT failures as plain errors', async () => {
	const tree = vi
		.fn()
		.mockRejectedValue(new Error('Repo session "session-1" was not found.'))
	mocks.repoSessionRpc.mockReturnValue({ tree })

	const error = await repoTreeCapability
		.handler({ session_id: 'session-1' }, createContext())
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(error).toBeInstanceOf(Error)
	expect(error).not.toBeInstanceOf(McpCallerError)
	expect(error).toMatchObject({
		message: 'Repo session "session-1" was not found.',
	})
})

test('repo_tree summarizes an existing subtree', async () => {
	const tree = vi.fn().mockResolvedValue({
		path: '',
		name: 'session',
		type: 'directory',
		size: 0,
		children: [
			{
				path: 'README.md',
				name: 'README.md',
				type: 'file',
				size: 12,
			},
			{
				path: 'src',
				name: 'src',
				type: 'directory',
				size: 0,
				children: [
					{
						path: 'src/index.ts',
						name: 'index.ts',
						type: 'file',
						size: 40,
					},
				],
			},
		],
	})
	mocks.repoSessionRpc.mockReturnValue({ tree })

	await expect(
		repoTreeCapability.handler({ session_id: 'session-1' }, createContext()),
	).resolves.toEqual({
		path: '',
		files: 2,
		directories: 2,
		symlinks: 0,
		total_bytes: 52,
		max_depth: 2,
	})
})
