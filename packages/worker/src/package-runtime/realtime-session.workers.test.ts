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

test('package realtime session broadcast only returns delivered session ids', async () => {
	const binding = createBinding()
	const stub = env.PACKAGE_REALTIME_SESSION.get(
		env.PACKAGE_REALTIME_SESSION.idFromName(
			JSON.stringify([binding.userId, binding.packageId]),
		),
	)

	await runInDurableObject(stub, async (instance: PackageRealtimeSession) => {
		const anyInstance = instance as unknown as {
			listSessions: (input?: {
				facet?: string | null
				topic?: string | null
			}) => Array<{ session_id: string }>
			emitToSession: (
				sessionId: string,
				data: unknown,
			) => Promise<{ delivered: boolean }>
			broadcast: (input: {
				facet?: string | null
				topic?: string | null
				data: unknown
			}) => Promise<{ deliveredCount: number; sessionIds: Array<string> }>
		}

		anyInstance.listSessions = () => [
			{ session_id: 'session-1' },
			{ session_id: 'session-2' },
		]
		anyInstance.emitToSession = async (sessionId) => ({
			delivered: sessionId === 'session-1',
		})

		await expect(
			anyInstance.broadcast({
				data: { type: 'broadcast' },
			}),
		).resolves.toEqual({
			deliveredCount: 1,
			sessionIds: ['session-1'],
		})
	})
})

test('package realtime session broadcast skips sessions whose send throws', async () => {
	const binding = createBinding()
	const stub = env.PACKAGE_REALTIME_SESSION.get(
		env.PACKAGE_REALTIME_SESSION.idFromName(
			JSON.stringify([binding.userId, binding.packageId]),
		),
	)

	await runInDurableObject(stub, async (instance: PackageRealtimeSession) => {
		const anyInstance = instance as unknown as {
			listSessions: (input?: {
				facet?: string | null
				topic?: string | null
			}) => Array<{ session_id: string }>
			getSocketBySessionId: (sessionId: string) => { send: (data: string) => void }
			stateSnapshot: {
				sessions: Record<string, { id: string }>
			}
			persistState: () => Promise<void>
			broadcast: (input: {
				facet?: string | null
				topic?: string | null
				data: unknown
			}) => Promise<{ deliveredCount: number; sessionIds: Array<string> }>
		}

		anyInstance.listSessions = () => [
			{ session_id: 'session-1' },
			{ session_id: 'session-2' },
		]
		anyInstance.stateSnapshot = {
			sessions: {
				'session-1': { id: 'session-1' },
				'session-2': { id: 'session-2' },
			},
		}
		anyInstance.persistState = async () => undefined
		anyInstance.getSocketBySessionId = (sessionId) => ({
			send: () => {
				if (sessionId === 'session-2') {
					throw new Error('socket closing')
				}
			},
		})

		await expect(
			anyInstance.broadcast({
				data: { type: 'broadcast' },
			}),
		).resolves.toEqual({
			deliveredCount: 1,
			sessionIds: ['session-1'],
		})
	})
})

test('package realtime session close action swallows socket close errors', async () => {
	const binding = createBinding()
	const stub = env.PACKAGE_REALTIME_SESSION.get(
		env.PACKAGE_REALTIME_SESSION.idFromName(
			JSON.stringify([binding.userId, binding.packageId]),
		),
	)

	await runInDurableObject(stub, async (instance: PackageRealtimeSession) => {
		const anyInstance = instance as unknown as {
			stateSnapshot: {
				sessions: Record<string, { id: string; topics: Array<string> }>
			}
			getSocketBySessionId: (sessionId: string) => { close: () => void }
			applyHookActions: (
				sessionId: string,
				actions: Array<{ type: 'close'; code?: number; reason?: string }>,
			) => Promise<void>
		}

		anyInstance.stateSnapshot = {
			sessions: {
				'session-1': { id: 'session-1', topics: [] },
			},
		}
		anyInstance.getSocketBySessionId = () => ({
			close: () => {
				throw new Error('socket already closing')
			},
		})

		await expect(
			anyInstance.applyHookActions('session-1', [
				{
					type: 'close',
				},
			]),
		).resolves.toBeUndefined()
	})
})

test('package realtime disconnect endpoint swallows socket close errors', async () => {
	const binding = createBinding()
	const stub = env.PACKAGE_REALTIME_SESSION.get(
		env.PACKAGE_REALTIME_SESSION.idFromName(
			JSON.stringify([binding.userId, binding.packageId]),
		),
	)

	await runInDurableObject(stub, async (instance: PackageRealtimeSession) => {
		const anyInstance = instance as unknown as {
			initializeBinding: (bindingState: unknown) => Promise<void>
			getSocketBySessionId: (sessionId: string) => { close: () => void }
			fetch: (request: Request) => Promise<Response>
		}

		anyInstance.initializeBinding = async () => undefined
		anyInstance.getSocketBySessionId = () => ({
			close: () => {
				throw new Error('socket already closing')
			},
		})

		const response = await anyInstance.fetch(
			new Request('https://package-realtime.invalid/session/disconnect', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					binding: {
						userId: 'user-1',
						packageId: 'package-1',
						kodyId: 'example',
						sourceId: 'source-1',
						baseUrl: 'https://example.com',
					},
					sessionId: 'session-1',
				}),
			}),
		)

		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ ok: true })
	})
})
