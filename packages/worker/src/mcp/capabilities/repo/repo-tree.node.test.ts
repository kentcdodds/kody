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

test('repo_tree maps missing-path ENOENT to McpCallerError and summarizes existing trees', async () => {
	const missing = vi
		.fn()
		.mockRejectedValue(
			Object.assign(
				new Error('ENOENT: no such file or directory: /session/docs'),
				{ code: 'ENOENT' },
			),
		)
	mocks.repoSessionRpc.mockReturnValue({ tree: missing })

	const missingError = await repoTreeCapability
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

	expect(missingError).toBeInstanceOf(McpCallerError)
	expect(missingError).toMatchObject({
		message: 'Path "docs" was not found in the repo session workspace.',
	})
	expect(missing).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: 'user-alice',
		path: 'docs',
		maxDepth: undefined,
	})

	const nestedMissing = Object.assign(
		new Error('ENOENT: no such file or directory: /session/tests'),
		{ code: 'ENOENT' },
	)
	const nested = vi.fn().mockRejectedValue(
		Object.assign(new Error('Repository tree RPC failed.'), {
			cause: nestedMissing,
		}),
	)
	mocks.repoSessionRpc.mockReturnValue({ tree: nested })

	const nestedError = await repoTreeCapability
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

	expect(nestedError).toBeInstanceOf(McpCallerError)
	expect(nestedError).toMatchObject({
		message: 'Path "tests" was not found in the repo session workspace.',
	})

	const notFound = vi
		.fn()
		.mockRejectedValue(new Error('Repo session "session-1" was not found.'))
	mocks.repoSessionRpc.mockReturnValue({ tree: notFound })

	const plainError = await repoTreeCapability
		.handler({ session_id: 'session-1' }, createContext())
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(plainError).toBeInstanceOf(Error)
	expect(plainError).not.toBeInstanceOf(McpCallerError)
	expect(plainError).toMatchObject({
		message: 'Repo session "session-1" was not found.',
	})

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
