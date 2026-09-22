import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) => mocks.repoSessionRpc(...args),
}))

const { repoReadFileCapability } = await import('./repo-read-file.ts')

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

const source = Array.from(
	{ length: 200 },
	(_, index) => `line ${String(index + 1)}`,
).join('\n')

const readme = `# Package

## Export JSDoc

How to document an export.

## Intent

What the package does.
`

test('repoReadFile focuses # line and heading anchors and rejects missing ones', async () => {
	const readFile = vi.fn(async ({ path }: { path: string }) => {
		if (path === 'src/file.ts') return { path, content: source }
		if (path === 'README.md') return { path, content: readme }
		return { path, content: null }
	})
	mocks.repoSessionRpc.mockReturnValue({ readFile })

	const line = await repoReadFileCapability.handler(
		{ session_id: 'session-1', path: 'src/file.ts#L165' },
		createContext(),
	)
	expect(readFile).toHaveBeenCalledWith(
		expect.objectContaining({ path: 'src/file.ts' }),
	)
	expect(line.path).toBe('src/file.ts')
	expect(line.anchor).toMatchObject({
		kind: 'lines',
		requested_start_line: 165,
		requested_end_line: 165,
		start_line: 145,
		end_line: 185,
	})
	expect(line.content).toContain('165|line 165')
	expect(line.content).not.toContain('144|line 144')
	expect(line.content).not.toBe(source)

	const range = await repoReadFileCapability.handler(
		{ session_id: 'session-1', path: 'src/file.ts#L165-L180' },
		createContext(),
	)
	expect(range.anchor).toMatchObject({
		kind: 'lines',
		requested_start_line: 165,
		requested_end_line: 180,
		start_line: 165,
		end_line: 180,
	})
	expect(range.content).not.toContain('164|line 164')
	expect(range.content).not.toContain('181|line 181')

	const heading = await repoReadFileCapability.handler(
		{ session_id: 'session-1', path: 'README.md#export-jsdoc' },
		createContext(),
	)
	expect(heading.anchor).toMatchObject({
		kind: 'heading',
		heading: { slug: 'export-jsdoc' },
	})
	expect(heading.content).toContain('How to document an export.')
	expect(heading.content).not.toContain('What the package does.')

	const whole = await repoReadFileCapability.handler(
		{ session_id: 'session-1', path: 'src/file.ts' },
		createContext(),
	)
	expect(whole).toEqual({ path: 'src/file.ts', content: source })

	const missingLine = await repoReadFileCapability
		.handler(
			{ session_id: 'session-1', path: 'src/file.ts#L999' },
			createContext(),
		)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missingLine).toBeInstanceOf(McpCallerError)
	expect((missingLine as Error).message).toMatch(/past the end/)
	expect((missingLine as Error).message).not.toContain('line 1')

	const missingHeading = await repoReadFileCapability
		.handler(
			{ session_id: 'session-1', path: 'README.md#missing-heading' },
			createContext(),
		)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missingHeading).toBeInstanceOf(McpCallerError)
	expect((missingHeading as Error).message).toMatch(
		/Unknown heading "missing-heading"/,
	)

	const emptyFragment = await repoReadFileCapability
		.handler({ session_id: 'session-1', path: 'README.md#' }, createContext())
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(emptyFragment).toBeInstanceOf(McpCallerError)
	expect((emptyFragment as Error).message).toMatch(/must not be empty/)
})
