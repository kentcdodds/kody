import { expect, test, vi } from 'vitest'
import { handleDoPitrRequest } from './do-pitr-maintenance.ts'

function createNamespace() {
	const rpc = {
		getRecoveryBookmark: vi.fn<
			(input: { timestampMs: number }) => Promise<{ bookmark: string }>
		>(async () => ({ bookmark: 'resolved-bookmark' })),
		restoreToBookmark: vi.fn<
			(input: { bookmark: string }) => Promise<{ undoBookmark: string }>
		>(async () => ({ undoBookmark: 'undo-bookmark' })),
	}
	return {
		rpc,
		namespace: {
			idFromName: vi.fn<(name: string) => string>((name) => name),
			get: vi.fn<(id: string) => typeof rpc>(() => rpc),
		},
	}
}

function createRequest(
	body: Record<string, unknown>,
	authorization?: string,
): Request {
	return new Request('https://example.com/__maintenance/do-pitr', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(authorization ? { Authorization: authorization } : {}),
		},
		body: JSON.stringify(body),
	})
}

const bookmarkRequest = {
	operation: 'get-recovery-bookmark',
	kind: 'mailbox',
	userId: 'stable-user-id',
}
const productionEnv = {
	SENTRY_ENVIRONMENT: 'production',
	DR_RESTORE_SECRET: 'correct',
}

test('DO PITR maintenance route fails closed without its shared recovery secret', async () => {
	const timestampMs = Date.now() - 60_000
	const cases: Array<[Request, Partial<Env>, number]> = [
		[
			createRequest({ ...bookmarkRequest, timestampMs }, 'Bearer correct'),
			{ ...productionEnv, SENTRY_ENVIRONMENT: 'preview' },
			403,
		],
		[
			createRequest({ ...bookmarkRequest, timestampMs }),
			{ SENTRY_ENVIRONMENT: 'production' },
			503,
		],
		[createRequest({ ...bookmarkRequest, timestampMs }), productionEnv, 401],
		[
			createRequest(
				{
					...bookmarkRequest,
					operation: 'restore-to-bookmark',
					bookmark: 'bookmark',
				},
				'Bearer wrong',
			),
			productionEnv,
			401,
		],
	]
	for (const [request, env, status] of cases) {
		const response = await handleDoPitrRequest(request, env as Env)
		expect(response.status).toBe(status)
		if (status === 403) await expect(response.text()).resolves.toBe('Forbidden')
	}
})

test('DO PITR maintenance route targets exact user-scoped object names and round-trips bookmarks', async () => {
	const mailbox = createNamespace()
	const runLog = createNamespace()
	const userMeter = createNamespace()
	const storageRunner = createNamespace()
	const timestampMs = Date.now() - 60_000
	const logger = { log: vi.fn<(message: string) => void>() }
	const env = {
		...productionEnv,
		MAILBOX: mailbox.namespace,
		RUN_LOG: runLog.namespace,
		USER_METER: userMeter.namespace,
		STORAGE_RUNNER: storageRunner.namespace,
	} as unknown as Env
	const targets = [
		{ kind: 'mailbox', binding: mailbox, expectedName: 'stable-user-id' },
		{ kind: 'run-log', binding: runLog, expectedName: 'stable-user-id' },
		{ kind: 'user-meter', binding: userMeter, expectedName: 'stable-user-id' },
		{
			kind: 'storage-runner',
			binding: storageRunner,
			storageId: 'package:package-id',
			expectedName: '["stable-user-id","package:package-id"]',
		},
	] as const

	for (const target of targets) {
		const common = {
			kind: target.kind,
			userId: 'stable-user-id',
			...('storageId' in target ? { storageId: target.storageId } : {}),
		}
		const bookmarkResponse = await handleDoPitrRequest(
			createRequest(
				{
					operation: 'get-recovery-bookmark',
					...common,
					timestampMs,
				},
				'Bearer correct',
			),
			env,
		)
		expect(bookmarkResponse.status).toBe(200)
		await expect(bookmarkResponse.json()).resolves.toMatchObject({
			ok: true,
			operation: 'get-recovery-bookmark',
			...common,
			bookmark: 'resolved-bookmark',
		})
		expect(target.binding.namespace.idFromName).toHaveBeenCalledWith(
			target.expectedName,
		)
		expect(target.binding.rpc.getRecoveryBookmark).toHaveBeenCalledWith({
			timestampMs,
		})

		const restoreResponse = await handleDoPitrRequest(
			createRequest(
				{
					operation: 'restore-to-bookmark',
					...common,
					bookmark: 'resolved-bookmark',
				},
				'Bearer correct',
			),
			env,
			logger,
		)
		expect(restoreResponse.status).toBe(200)
		await expect(restoreResponse.json()).resolves.toMatchObject({
			ok: true,
			operation: 'restore-to-bookmark',
			...common,
			operationId: expect.any(String),
			undoBookmark: 'undo-bookmark',
		})
		expect(target.binding.rpc.restoreToBookmark).toHaveBeenCalledWith({
			bookmark: 'resolved-bookmark',
		})
	}
	expect(logger.log).toHaveBeenCalledTimes(targets.length)
	expect(logger.log.mock.calls.map(([message]) => JSON.parse(message))).toEqual(
		targets.map((target) =>
			expect.objectContaining({
				event: 'do-pitr-operator-restore',
				operationId: expect.any(String),
				kind: target.kind,
				userId: 'stable-user-id',
				...('storageId' in target ? { storageId: target.storageId } : {}),
				targetBookmark: 'resolved-bookmark',
				undoBookmark: 'undo-bookmark',
			}),
		),
	)
})

test('DO PITR maintenance route rejects timestamps outside the provider window', async () => {
	const mailbox = createNamespace()
	const env = { ...productionEnv, MAILBOX: mailbox.namespace } as unknown as Env
	const invalidTimestamps = [
		Date.now() + 60_000,
		Date.now() - 31 * 24 * 60 * 60 * 1000,
	]

	for (const timestampMs of invalidTimestamps) {
		const response = await handleDoPitrRequest(
			createRequest({ ...bookmarkRequest, timestampMs }, 'Bearer correct'),
			env,
		)
		expect(response.status).toBe(500)
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			code: 'invalid-request',
			error: expect.stringContaining('previous 30 days'),
		})
	}
	expect(mailbox.rpc.getRecoveryBookmark).not.toHaveBeenCalled()
})
