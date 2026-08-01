import { expect, test, vi } from 'vitest'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'

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
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const db = {
		prepare(query: string) {
			return {
				bind() {
					return {
						async first() {
							if (query.includes('deleting_at')) {
								return { deleting_at: null }
							}
							return null
						},
						async run() {
							return { meta: { changes: 1 } }
						},
						async all() {
							return { results: [], meta: { changes: 0 } }
						},
					}
				},
			}
		},
		async batch() {
			return []
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
		USER_METER: meter.env.USER_METER,
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
			expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
			startHandler()
			await finish
			return Response.json({ ok: true })
		},
	)
	await started
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
	finishHandler()
	await expect(responsePromise).resolves.toMatchObject({ status: 200 })
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
})
