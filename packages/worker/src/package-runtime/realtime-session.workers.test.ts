import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { packageRealtimeSessionRpc, PackageRealtimeSession } from './realtime-session.ts'

function createBinding(overrides?: Partial<{
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
}>) {
	return {
		env,
		userId: overrides?.userId ?? 'user-1',
		packageId: overrides?.packageId ?? 'package-1',
		kodyId: overrides?.kodyId ?? 'example',
		sourceId: overrides?.sourceId ?? 'source-1',
		baseUrl: overrides?.baseUrl ?? 'https://example.com',
	}
}

test('package realtime session DO can list, emit, and broadcast with no active sessions', async () => {
	const rpc = packageRealtimeSessionRpc(createBinding())

	await expect(rpc.listSessions()).resolves.toEqual({ sessions: [] })
	await expect(
		rpc.emit('missing-session', { type: 'hello' }),
	).resolves.toEqual({
		delivered: false,
		reason: 'session_not_connected',
	})
	await expect(
		rpc.broadcast({ data: { type: 'broadcast' } }),
	).resolves.toEqual({
		deliveredCount: 0,
		sessionIds: [],
	})
})

test('package realtime session DO is addressable as a durable object', async () => {
	const binding = createBinding()
	const stub = env.PACKAGE_REALTIME_SESSION.get(
		env.PACKAGE_REALTIME_SESSION.idFromName(
			JSON.stringify([binding.userId, binding.packageId]),
		),
	)

	await runInDurableObject(
		stub,
		async (instance: PackageRealtimeSession, state) => {
			expect(instance).toBeInstanceOf(PackageRealtimeSession)
			expect(state.storage.sql.databaseSize).toBeGreaterThanOrEqual(0)
		},
	)
})
