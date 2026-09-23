import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	packageRealtimeSessionRpc,
	PackageRealtimeSession,
} from './realtime-session.ts'

function createBinding(
	overrides?: Partial<{
		userId: string
		packageId: string
		kodyId: string
		sourceId: string
		baseUrl: string
	}>,
) {
	return {
		env,
		userId: overrides?.userId ?? 'user-1',
		packageId: overrides?.packageId ?? 'package-1',
		kodyId: overrides?.kodyId ?? 'example',
		sourceId: overrides?.sourceId ?? 'source-1',
		baseUrl: overrides?.baseUrl ?? 'https://example.com',
	}
}

function getStub(binding: ReturnType<typeof createBinding>) {
	return env.PACKAGE_REALTIME_SESSION.get(
		env.PACKAGE_REALTIME_SESSION.idFromName(
			JSON.stringify([binding.userId, binding.packageId]),
		),
	)
}

test('package realtime session DO lists empty sessions and is addressable as a durable object', async () => {
	const binding = createBinding()
	const rpc = packageRealtimeSessionRpc(binding)

	await expect(rpc.listSessions()).resolves.toEqual({ sessions: [] })
	await expect(rpc.emit('missing-session', { type: 'hello' })).resolves.toEqual(
		{
			delivered: false,
			reason: 'session_not_connected',
		},
	)
	await expect(rpc.broadcast({ data: { type: 'broadcast' } })).resolves.toEqual(
		{
			deliveredCount: 0,
			sessionIds: [],
		},
	)

	const stub = getStub(binding)

	await runInDurableObject(
		stub,
		async (instance: PackageRealtimeSession, state) => {
			expect(instance).toBeInstanceOf(PackageRealtimeSession)
			expect(state.storage.sql.databaseSize).toBeGreaterThanOrEqual(0)
		},
	)
})

test('package realtime session broadcast and disconnect paths tolerate partial delivery and socket close errors', async () => {
	const binding = createBinding()
	const stub = getStub(binding)

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
			getSocketBySessionId: (sessionId: string) => {
				send: (data: string) => void
				close: () => void
			}
			stateSnapshot: {
				sessions: Record<string, { id: string; topics?: Array<string> }>
			}
			persistState: () => Promise<void>
			broadcast: (input: {
				facet?: string | null
				topic?: string | null
				data: unknown
			}) => Promise<{ deliveredCount: number; sessionIds: Array<string> }>
			applyHookActions: (
				sessionId: string,
				actions: Array<{ type: 'close'; code?: number; reason?: string }>,
			) => Promise<void>
			initializeBinding: (bindingState: unknown) => Promise<void>
			fetch: (request: Request) => Promise<Response>
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
			close: () => {
				throw new Error('socket already closing')
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

		anyInstance.stateSnapshot = {
			sessions: {
				'session-1': { id: 'session-1', topics: [] },
			},
		}

		await expect(
			anyInstance.applyHookActions('session-1', [
				{
					type: 'close',
				},
			]),
		).resolves.toBeUndefined()

		anyInstance.initializeBinding = async () => undefined

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

test('package realtime session closes open sockets without running hooks once the owner is suspended', async () => {
	await ensureUsersTestSchema({
		db: env.APP_DB,
		columns: ['email_verified_at'],
	})
	const email = `realtime-suspended-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `rtsusp-${crypto.randomUUID().slice(0, 8)}`,
		stableUserId: userId,
	})
	await env.APP_DB.prepare(
		`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()
	const binding = createBinding({ userId })

	await runInDurableObject(
		getStub(binding),
		async (instance: PackageRealtimeSession) => {
			const anyInstance = instance as unknown as {
				stateSnapshot: {
					binding: unknown
					sessions: Record<string, unknown>
				}
				persistState: () => Promise<void>
				loadSessionId: (ws: WebSocket) => string | null
				getPackageAppWorker: () => Promise<never>
				closeAllSockets: (code: number, reason: string) => void
				handleWebSocketMessage: (
					ws: WebSocket,
					message: string,
				) => Promise<void>
				fetch: (request: Request) => Promise<Response>
			}
			anyInstance.stateSnapshot = {
				binding: {
					userId: binding.userId,
					packageId: binding.packageId,
					kodyId: binding.kodyId,
					sourceId: binding.sourceId,
					baseUrl: binding.baseUrl,
				},
				sessions: {
					'session-1': {
						id: 'session-1',
						facet: 'main',
						connectedAt: '2026-09-23T00:00:00.000Z',
						lastSeenAt: '2026-09-23T00:00:00.000Z',
						topics: [],
					},
				},
			}
			anyInstance.persistState = async () => undefined
			anyInstance.loadSessionId = () => 'session-1'
			let hookWorkerRequested = false
			anyInstance.getPackageAppWorker = async () => {
				hookWorkerRequested = true
				throw new Error('Suspended accounts must not reach package hooks.')
			}
			const closes: Array<[number, string]> = []
			anyInstance.closeAllSockets = (code, reason) => {
				closes.push([code, reason])
			}

			await expect(
				anyInstance.handleWebSocketMessage({} as WebSocket, 'hello'),
			).resolves.toBeUndefined()
			expect(hookWorkerRequested).toBe(false)
			expect(closes).toEqual([[1008, 'account-suspended']])

			const post = (path: string, body: Record<string, unknown>) =>
				anyInstance.fetch(
					new Request(`https://package-realtime.invalid/session/${path}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							binding: anyInstance.stateSnapshot.binding,
							...body,
						}),
					}),
				)
			const emitted = await post('emit', {
				sessionId: 'session-1',
				data: { type: 'hello' },
			})
			await expect(emitted.json()).resolves.toEqual({
				delivered: false,
				reason: 'account_suspended',
			})
			const broadcast = await post('broadcast', { data: { type: 'hello' } })
			await expect(broadcast.json()).resolves.toEqual({
				deliveredCount: 0,
				sessionIds: [],
			})
			expect(closes).toEqual([
				[1008, 'account-suspended'],
				[1008, 'account-suspended'],
				[1008, 'account-suspended'],
			])
		},
	)
})
