import { expect, test } from 'vitest'
import {
	forgetInboundMcpConnectionLastUsed,
	listInboundMcpConnectionLastUsed,
	recordInboundMcpConnectionLastUsed,
	shouldSkipInboundMcpConnectionLastUsedTouch,
} from '#worker/inbound-mcp-connection-last-used.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

test('inbound MCP last-used debounce, record, list, and forget stay per user and no-op without USER_METER', async () => {
	expect(
		shouldSkipInboundMcpConnectionLastUsedTouch({
			previousLastUsedAt: null,
			nextLastUsedAt: '2026-03-20T12:00:00.000Z',
		}),
	).toBe(false)
	expect(
		shouldSkipInboundMcpConnectionLastUsedTouch({
			previousLastUsedAt: '2026-03-20T11:55:00.000Z',
			nextLastUsedAt: '2026-03-20T12:00:00.000Z',
		}),
	).toBe(true)
	expect(
		shouldSkipInboundMcpConnectionLastUsedTouch({
			previousLastUsedAt: '2026-03-20T11:54:59.000Z',
			nextLastUsedAt: '2026-03-20T12:00:00.000Z',
		}),
	).toBe(false)
	expect(() =>
		shouldSkipInboundMcpConnectionLastUsedTouch({
			previousLastUsedAt: '2026-03-20T11:00:00.000Z',
			nextLastUsedAt: 'not-a-date',
		}),
	).toThrow(/ISO datetime/)

	await expect(
		recordInboundMcpConnectionLastUsed({
			env: {},
			userId: 'user-no-meter',
			clientId: 'client-a',
		}),
	).resolves.toBeUndefined()
	await expect(
		listInboundMcpConnectionLastUsed({
			env: {},
			userId: 'user-no-meter',
		}),
	).resolves.toEqual(new Map())

	const meter = createInMemoryUserMeterEnv()
	const userId = `user-${crypto.randomUUID()}`
	const otherUserId = `user-${crypto.randomUUID()}`
	const clientId = `https://cursor.com/oauth/${crypto.randomUUID()}/client.json`
	const firstUsedAt = '2026-03-20T12:00:00.000Z'
	const firstUsedMs = Date.parse(firstUsedAt)
	const laterUsedAt = '2026-03-20T12:05:01.000Z'

	await recordInboundMcpConnectionLastUsed({
		env: meter.env,
		userId,
		clientId,
		lastUsedAt: firstUsedAt,
		nowMs: firstUsedMs,
	})
	await recordInboundMcpConnectionLastUsed({
		env: meter.env,
		userId,
		clientId,
		lastUsedAt: '2026-03-20T12:01:00.000Z',
		nowMs: firstUsedMs + 60_000,
	})
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId,
		}),
	).toEqual(new Map([[clientId, firstUsedAt]]))

	await recordInboundMcpConnectionLastUsed({
		env: meter.env,
		userId,
		clientId,
		lastUsedAt: laterUsedAt,
		nowMs: Date.parse(laterUsedAt),
	})
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId,
		}),
	).toEqual(new Map([[clientId, laterUsedAt]]))

	await recordInboundMcpConnectionLastUsed({
		env: meter.env,
		userId: otherUserId,
		clientId,
		lastUsedAt: firstUsedAt,
		nowMs: firstUsedMs,
	})
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId: otherUserId,
		}),
	).toEqual(new Map([[clientId, firstUsedAt]]))

	await forgetInboundMcpConnectionLastUsed({
		env: meter.env,
		userId,
		clientId,
	})
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId,
		}),
	).toEqual(new Map())
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId: otherUserId,
		}),
	).toEqual(new Map([[clientId, firstUsedAt]]))

	const reusedAt = '2026-03-20T12:02:00.000Z'
	await recordInboundMcpConnectionLastUsed({
		env: meter.env,
		userId,
		clientId,
		lastUsedAt: reusedAt,
		nowMs: Date.parse(reusedAt),
	})
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId,
		}),
	).toEqual(new Map([[clientId, reusedAt]]))
})

test('inbound MCP last-used records again after a failed UserMeter touch', async () => {
	const meter = createInMemoryUserMeterEnv()
	const namespace = meter.env.USER_METER
	if (!namespace) throw new Error('expected in-memory USER_METER')
	const userId = `user-${crypto.randomUUID()}`
	const clientId = `https://cursor.com/oauth/${crypto.randomUUID()}/client.json`
	const usedAt = '2026-03-20T12:00:00.000Z'
	let failNextTouch = true
	const failingEnv: UserMeterEnv = {
		USER_METER: {
			idFromName: (name: string) => namespace.idFromName(name),
			get(id: DurableObjectId) {
				const stub = namespace.get(id) as {
					touchInboundConnectionLastUsed: (input: {
						clientId: string
						lastUsedAt: string
					}) => Promise<{ updated: boolean }>
					listInboundConnectionLastUsed: () => Promise<
						Array<{ clientId: string; lastUsedAt: string }>
					>
				}
				return {
					...stub,
					async touchInboundConnectionLastUsed(input: {
						clientId: string
						lastUsedAt: string
					}) {
						if (failNextTouch) {
							failNextTouch = false
							throw new Error('meter down')
						}
						return stub.touchInboundConnectionLastUsed(input)
					},
				}
			},
		} as DurableObjectNamespace,
	}

	await expect(
		recordInboundMcpConnectionLastUsed({
			env: failingEnv,
			userId,
			clientId,
			lastUsedAt: usedAt,
			nowMs: Date.parse(usedAt),
		}),
	).rejects.toThrow(/meter down/)
	await recordInboundMcpConnectionLastUsed({
		env: failingEnv,
		userId,
		clientId,
		lastUsedAt: usedAt,
		nowMs: Date.parse(usedAt),
	})
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId,
		}),
	).toEqual(new Map([[clientId, usedAt]]))
})
