import { expect, test, vi } from 'vitest'

const authMock = vi.hoisted(() => ({
	loadResolvedRequestAuth: vi.fn(),
}))

vi.mock('./request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: authMock.loadResolvedRequestAuth,
}))

const { createAccountWriteLeaseMiddleware } =
	await import('./account-write-lease-middleware.ts')

test('authenticated delayed mutation holds web lease through handler completion', async () => {
	authMock.loadResolvedRequestAuth.mockResolvedValue({
		sessionUserId: '1',
		user: {
			accountDeleting: false,
			mcpUser: { userId: 'user-a' },
		},
	})
	let active = 0
	const db = {
		prepare(query: string) {
			return {
				bind() {
					return {
						async run() {
							if (query.includes('active_write_count + 1')) active += 1
							if (query.includes('MAX(active_write_count - 1')) active -= 1
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
	let startHandler: () => void = () => undefined
	let finishHandler: () => void = () => undefined
	const started = new Promise<void>((resolve) => {
		startHandler = resolve
	})
	const finish = new Promise<void>((resolve) => {
		finishHandler = resolve
	})
	const middleware = createAccountWriteLeaseMiddleware({
		APP_DB: db,
	} as Env)
	const responsePromise = middleware(
		{
			request: new Request('https://example.com/account/mcp-servers.json', {
				method: 'POST',
			}),
			url: new URL('https://example.com/account/mcp-servers.json'),
			params: {},
			context: new Map(),
		} as never,
		async () => {
			startHandler()
			await finish
			return Response.json({ ok: true })
		},
	)
	await started
	expect(active).toBe(1)
	finishHandler()
	await expect(responsePromise).resolves.toMatchObject({ status: 200 })
	expect(active).toBe(0)
})
