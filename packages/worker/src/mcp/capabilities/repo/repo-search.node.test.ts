import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildRepoSearchInvalidRegexCallerMessage } from '#worker/repo/repo-session-caller-error.ts'

const mocks = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mocks.repoSessionRpc(...args),
}))

const { repoSearchCapability } = await import('./repo-search.ts')

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

test('repo_search maps invalid regex DO errors to McpCallerError', async () => {
	const compileMessage =
		'Invalid regular expression: /(?s).|^$/gi: Invalid group'
	const search = vi
		.fn()
		.mockRejectedValue(
			new Error(buildRepoSearchInvalidRegexCallerMessage(compileMessage)),
		)
	mocks.repoSessionRpc.mockReturnValue({ search })

	const error = await repoSearchCapability
		.handler(
			{
				session_id: 'session-1',
				pattern: '(?s).|^$',
				mode: 'regex',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(error).toBeInstanceOf(McpCallerError)
	expect((error as Error).message).toContain('invalid regex')
	expect((error as Error).message).toContain('JavaScript RegExp')
})

test('repo_search maps nested invalid regex causes to McpCallerError', async () => {
	const nestedMessage = buildRepoSearchInvalidRegexCallerMessage(
		'Invalid regular expression: /(?i)foo/: Invalid group',
	)
	const search = vi.fn().mockRejectedValue(
		new Error('Repo session search failed', {
			cause: new Error(nestedMessage),
		}),
	)
	mocks.repoSessionRpc.mockReturnValue({ search })

	const error = await repoSearchCapability
		.handler(
			{
				session_id: 'session-1',
				pattern: '(?i)foo',
				mode: 'regex',
			},
			createContext(),
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(error).toBeInstanceOf(McpCallerError)
	expect((error as Error).message).toBe(nestedMessage)
})

test('repo_search rethrows non-regex failures unchanged', async () => {
	const boom = new Error('Durable Object storage unavailable')
	const search = vi.fn().mockRejectedValue(boom)
	mocks.repoSessionRpc.mockReturnValue({ search })

	await expect(
		repoSearchCapability.handler(
			{
				session_id: 'session-1',
				pattern: 'hello',
			},
			createContext(),
		),
	).rejects.toBe(boom)
})
