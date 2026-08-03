import assert from 'node:assert/strict'

import {
	parseBackupManifest,
	serializeBackupManifest,
} from '@kody-internal/shared/backup-manifest.ts'
import { afterEach, test, vi } from 'vitest'

import {
	DATABASE_ID,
	MemoryBucket,
	environment,
	exportEnvelope,
	identityEnvelope,
} from './backup-control-plane-test-support.ts'
import { runBackupRuntime, type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError, objectKeyForPayload } from './backup-policy.ts'
import {
	mailboxPreDropRuntimePayload,
	mailboxPreDropWorkflowInstanceId,
	parseMailboxPreDropBackupRequest,
} from './mailbox-pre-drop-policy.ts'
import { runMailboxLegacyGraphPreDropBackup } from './mailbox-pre-drop-runtime.ts'
import { type MailboxPreDropBackupRequest } from './backup-types.ts'

afterEach(() => {
	vi.restoreAllMocks()
})

function healthySnapshot(overrides: Record<string, unknown> = {}) {
	return {
		authority_marker_count: 1,
		authority_frozen_at: '2026-08-03T12:00:00.000Z',
		authority_owner_count: 4,
		owner_count: 3,
		thread_count: 5,
		message_count: 8,
		attachment_count: 2,
		event_count: 13,
		provider_repair_count: 0,
		cutover_audit_count: 0,
		system_marker_violation_count: 0,
		system_provider_link_count: 0,
		system_reference_violation_count: 0,
		...overrides,
	}
}

function lockedBucket(): MemoryBucket {
	const bucket = new MemoryBucket()
	bucket.enableLockPolicy()
	return bucket
}

function queryEnvelope(rows: Array<Record<string, unknown>>): Response {
	return Response.json({ success: true, result: [{ results: rows }] })
}

function returningRowFromApprovalSql(sql: string): Record<string, unknown> {
	const match =
		/INSERT INTO email_user_graph_drop_approval \(([\s\S]*?)\)\nSELECT ([\s\S]*?)\nFROM current_snapshot/u.exec(
			sql,
		)
	assert.ok(match)
	const columns = match[1]!.split(',').map((value) => value.trim())
	const values = match[2]!.split(',').map((value) => {
		const trimmed = value.trim()
		if (trimmed.startsWith("'")) {
			return trimmed.slice(1, -1).replaceAll("''", "'")
		}
		return Number(trimmed)
	})
	return Object.fromEntries(
		columns.map((column, index) => [column, values[index]]),
	)
}

function createApi(input: {
	snapshots?: Array<Record<string, unknown>>
	approvalSql?: Array<string>
	exportCalls?: Array<string>
}) {
	const snapshots = input.snapshots ?? [healthySnapshot(), healthySnapshot()]
	let snapshotIndex = 0
	return {
		fetcher: async (
			request: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(request)
			if (url.endsWith('/query')) {
				const body = JSON.parse(String(init?.body)) as { sql: string }
				if (body.sql.includes('INSERT INTO email_user_graph_drop_approval')) {
					input.approvalSql?.push(body.sql)
					const row = returningRowFromApprovalSql(body.sql)
					return queryEnvelope([row])
				}
				const row = snapshots[Math.min(snapshotIndex, snapshots.length - 1)]!
				snapshotIndex += 1
				return queryEnvelope([row])
			}
			if (url.endsWith('/export')) {
				input.exportCalls?.push(url)
				return exportEnvelope('complete')
			}
			return identityEnvelope(1_000)
		},
		sleep: async () => undefined,
	}
}

class TestWorkflowStep implements BackupRuntimeStep {
	readonly executions: Array<string> = []
	private readonly cache = new Map<string, unknown>()
	private readonly afterStep?: (name: string) => void | Promise<void>

	constructor(afterStep?: (name: string) => void | Promise<void>) {
		this.afterStep = afterStep
	}

	async do<T>(
		name: string,
		config: unknown,
		callback: () => Promise<T>,
	): Promise<T>
	async do<T>(name: string, callback: () => Promise<T>): Promise<T>
	async do<T>(
		name: string,
		configOrCallback: unknown,
		callback?: () => Promise<T>,
	): Promise<T> {
		if (this.cache.has(name)) return this.cache.get(name) as T
		const execute =
			typeof configOrCallback === 'function'
				? (configOrCallback as () => Promise<T>)
				: callback!
		const result = await execute()
		this.cache.set(name, result)
		this.executions.push(name)
		await this.afterStep?.(name)
		return result
	}

	async sleep(): Promise<void> {}
}

function requestAtNow(): MailboxPreDropBackupRequest {
	return {
		requestId: '11111111-1111-4111-8111-111111111111',
		nonce: '0123456789abcdef0123456789abcdef',
		requestedAt: new Date(Date.now() - 1_000).toISOString(),
	}
}

function workflowEvent(request: MailboxPreDropBackupRequest) {
	return {
		instanceId: mailboxPreDropWorkflowInstanceId(request),
		payload: request,
		timestamp: new Date(),
	}
}

test('pre-drop workflow creates a unique signed backup and atomically returns a short-lived receipt', async () => {
	const bucket = lockedBucket()
	const env = environment(bucket)
	const request = requestAtNow()
	const approvalSql: Array<string> = []
	const step = new TestWorkflowStep()
	const receipt = await runMailboxLegacyGraphPreDropBackup(
		env,
		workflowEvent(request),
		step,
		{
			api: createApi({ approvalSql }),
			downloadFetcher: async () =>
				new Response('valid', { headers: { 'content-length': '5' } }),
			now: () => new Date(Date.now() + 1_000),
		},
	)

	assert.match(
		receipt.manifestKey,
		new RegExp(
			`^adhoc/mailbox-drop/d1/${DATABASE_ID}/.+-${request.nonce}-${request.requestId}/manifest\\.json$`,
		),
	)
	assert.equal(
		receipt.sqlObjectKey,
		receipt.manifestKey.replace(/manifest\.json$/u, 'backup-request.sql'),
	)
	assert.equal(receipt.issuedBy, 'backup-control-plane')
	assert.equal(receipt.authorityOwnerCount, 4)
	assert.equal(receipt.ownerCount, 3)
	assert.equal(receipt.threadCount, 5)
	assert.equal(receipt.messageCount, 8)
	assert.equal(receipt.attachmentCount, 2)
	assert.equal(receipt.eventCount, 13)
	assert.equal(
		Date.parse(receipt.expiresAt) - Date.parse(receipt.verifiedAt),
		2 * 60 * 60 * 1_000,
	)
	assert.equal(receipt.manifestSignatureSha256.length, 64)
	assert.equal(approvalSql.length, 1)
	assert.ok(step.executions.includes('mailbox-pre-drop-verify-live-r2-policy'))
	assert.match(approvalSql[0]!, /ON CONFLICT\(singleton\) DO UPDATE SET/u)
	assert.doesNotMatch(
		approvalSql[0]!,
		/signed_url|authorization|not-logged-secret/u,
	)

	const manifestObject = await bucket.get(receipt.manifestKey)
	assert.notEqual(manifestObject, null)
	const manifest = parseBackupManifest(await manifestObject!.json())
	assert.equal(manifest.payload.sql.objectKey, receipt.sqlObjectKey)
	assert.equal(manifest.payload.sql.sha256, receipt.sqlSha256)
	assert.equal(manifest.payload.buildCommit, receipt.buildCommit)

	const replay = await runMailboxLegacyGraphPreDropBackup(
		env,
		workflowEvent(request),
		step,
		{
			api: createApi({ approvalSql }),
			downloadFetcher: async () => {
				throw new Error('cached replay must not download')
			},
		},
	)
	assert.deepEqual(replay, receipt)
	assert.equal(approvalSql.length, 1)

	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	await assert.rejects(
		runMailboxLegacyGraphPreDropBackup(
			env,
			workflowEvent(request),
			new TestWorkflowStep(),
			{
				api: createApi({ approvalSql }),
				downloadFetcher: async () =>
					new Response('other', { headers: { 'content-length': '5' } }),
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'existing-object-source-mismatch',
	)
	assert.equal(approvalSql.length, 1)
	assert.equal(consoleError.mock.calls.length, 2)
	consoleError.mockRestore()
})

test('pre-drop workflow fails before export when the live adhoc policy is absent or weak', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const absentEnv = environment()
	absentEnv.BACKUP_BUCKET = {
		async put() {
			return null
		},
		async head() {
			return null
		},
	} as unknown as R2Bucket
	for (const testCase of [
		{ name: 'absent', env: absentEnv },
		{ name: 'weak', env: environment(new MemoryBucket()) },
	]) {
		const approvalSql: Array<string> = []
		const exportCalls: Array<string> = []
		await assert.rejects(
			runMailboxLegacyGraphPreDropBackup(
				testCase.env,
				workflowEvent(requestAtNow()),
				new TestWorkflowStep(),
				{ api: createApi({ approvalSql, exportCalls }) },
			),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === 'mailbox-pre-drop-r2-policy-unverified',
			testCase.name,
		)
		assert.equal(exportCalls.length, 0, testCase.name)
		assert.equal(approvalSql.length, 0, testCase.name)
	}
	assert.equal(consoleError.mock.calls.length, 2)
	consoleError.mockRestore()
})

test('pre-drop workflow rejects object and manifest tampering before approval', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	for (const tamper of ['object', 'signature'] as const) {
		const bucket = lockedBucket()
		const env = environment(bucket)
		const request = requestAtNow()
		const payload = mailboxPreDropRuntimePayload(env, request)
		const objectKey = objectKeyForPayload(payload, 'bookmark-1')
		const approvalSql: Array<string> = []
		const step = new TestWorkflowStep(async (name) => {
			if (name !== 'verify-stored-object-and-write-immutable-manifest') return
			if (tamper === 'object') {
				bucket.corrupt(objectKey, 'evil!')
				return
			}
			const object = await bucket.get(payload.manifestKey)
			assert.notEqual(object, null)
			const manifest = parseBackupManifest(await object!.json())
			manifest.signature.value =
				(manifest.signature.value.startsWith('A') ? 'B' : 'A') +
				manifest.signature.value.slice(1)
			bucket.corrupt(payload.manifestKey, serializeBackupManifest(manifest))
		})
		await assert.rejects(
			runMailboxLegacyGraphPreDropBackup(env, workflowEvent(request), step, {
				api: createApi({ approvalSql }),
				downloadFetcher: async () =>
					new Response('valid', {
						headers: { 'content-length': '5' },
					}),
			}),
			(error: unknown) =>
				error instanceof BackupError &&
				(tamper === 'object'
					? error.code === 'stored-object-mismatch'
					: error.code === 'mailbox-pre-drop-manifest-signature-invalid'),
		)
		assert.equal(approvalSql.length, 0)
	}
	assert.equal(consoleError.mock.calls.length, 2)
	consoleError.mockRestore()
})

test('pre-drop workflow blocks marker, repair, audit, system, and snapshot drift failures', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const failures = [
		{ authority_marker_count: 0 },
		{ provider_repair_count: 1 },
		{ cutover_audit_count: 1 },
		{ system_marker_violation_count: 1 },
		{ system_provider_link_count: 1 },
		{ system_reference_violation_count: 1 },
	]
	for (const failure of failures) {
		const bucket = new MemoryBucket()
		const env = environment(bucket)
		await assert.rejects(
			runMailboxLegacyGraphPreDropBackup(
				env,
				workflowEvent(requestAtNow()),
				new TestWorkflowStep(),
				{ api: createApi({ snapshots: [healthySnapshot(failure)] }) },
			),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === 'mailbox-pre-drop-preflight-failed',
		)
		assert.equal(bucket.puts.length, 0)
	}

	const bucket = lockedBucket()
	const approvalSql: Array<string> = []
	await assert.rejects(
		runMailboxLegacyGraphPreDropBackup(
			environment(bucket),
			workflowEvent(requestAtNow()),
			new TestWorkflowStep(),
			{
				api: createApi({
					snapshots: [healthySnapshot(), healthySnapshot({ message_count: 9 })],
					approvalSql,
				}),
				downloadFetcher: async () =>
					new Response('valid', {
						headers: { 'content-length': '5' },
					}),
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'mailbox-pre-drop-snapshot-drift',
	)
	assert.equal(approvalSql.length, 0)
	assert.equal(consoleError.mock.calls.length, failures.length + 1)
	consoleError.mockRestore()
})

test('pre-drop workflow rejects deletion drift during export', async () => {
	const bucket = lockedBucket()
	const approvalSql: Array<string> = []
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	await assert.rejects(
		runMailboxLegacyGraphPreDropBackup(
			environment(bucket),
			workflowEvent(requestAtNow()),
			new TestWorkflowStep(),
			{
				api: createApi({
					snapshots: [healthySnapshot(), healthySnapshot({ message_count: 7 })],
					approvalSql,
				}),
				downloadFetcher: async () =>
					new Response('valid', {
						headers: { 'content-length': '5' },
					}),
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'mailbox-pre-drop-snapshot-drift',
	)
	assert.equal(approvalSql.length, 0)
	consoleError.mockRestore()
})

test('request validation, same-day uniqueness, and scheduled lane isolation fail closed', async () => {
	const request = requestAtNow()
	const event = workflowEvent(request)
	assert.deepEqual(
		parseMailboxPreDropBackupRequest(
			request,
			event.timestamp,
			event.instanceId,
		),
		request,
	)
	const accessorRequest = { ...request }
	Object.defineProperty(accessorRequest, 'requestedAt', {
		enumerable: true,
		get: () => request.requestedAt,
	})
	const symbolRequest = { ...request }
	Object.defineProperty(symbolRequest, Symbol('extra'), {
		enumerable: true,
		value: 'extra',
	})
	for (const invalid of [
		{ ...request, sourceDatabaseId: DATABASE_ID },
		{ ...request, nonce: 'A'.repeat(32) },
		{ ...request, requestedAt: 'not-a-date' },
		{ ...request, requestedAt: '2026-02-30T12:00:00.000Z' },
		{ ...request, requestedAt: '2026-08-03T12:00:00Z' },
		Object.assign(Object.create({ inherited: true }), request),
		Object.assign(Object.create(null), request),
		accessorRequest,
		symbolRequest,
		{
			...request,
			requestedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
		},
		{
			...request,
			requestedAt: new Date(Date.now() + 1_000).toISOString(),
		},
	]) {
		assert.throws(
			() =>
				parseMailboxPreDropBackupRequest(
					invalid,
					event.timestamp,
					event.instanceId,
				),
			BackupError,
		)
	}
	assert.throws(
		() =>
			parseMailboxPreDropBackupRequest(
				request,
				event.timestamp,
				`${event.instanceId}-other`,
			),
		BackupError,
	)

	const env = environment()
	const sameRequestDifferentNonce = { ...request, nonce: 'e'.repeat(32) }
	assert.equal(
		mailboxPreDropWorkflowInstanceId(request),
		mailboxPreDropWorkflowInstanceId(sameRequestDifferentNonce),
	)
	const other = {
		...request,
		requestId: '22222222-2222-4222-8222-222222222222',
		nonce: 'f'.repeat(32),
	}
	assert.notEqual(
		mailboxPreDropWorkflowInstanceId(request),
		mailboxPreDropWorkflowInstanceId(other),
	)
	assert.notEqual(
		mailboxPreDropRuntimePayload(env, request).manifestKey,
		mailboxPreDropRuntimePayload(env, other).manifestKey,
	)

	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const custom = mailboxPreDropRuntimePayload(env, request)
	await assert.rejects(
		runBackupRuntime(
			env,
			{
				instanceId: event.instanceId,
				payload: custom,
				timestamp: event.timestamp,
			},
			new TestWorkflowStep(),
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'invalid-workflow-payload-kind',
	)
	assert.equal(consoleError.mock.calls.length, 1)

	const { kind: omittedKind, ...missingKind } = custom
	assert.equal(omittedKind, 'mailbox-legacy-graph-pre-drop')
	await assert.rejects(
		runBackupRuntime(
			env,
			{
				instanceId: event.instanceId,
				payload: missingKind,
				timestamp: event.timestamp,
			},
			new TestWorkflowStep(),
			{ payloadKind: 'mailbox-legacy-graph-pre-drop' },
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'invalid-workflow-payload-kind',
	)
	assert.equal(consoleError.mock.calls.length, 2)

	for (const invalidPayload of [
		{ ...custom, extra: true },
		Object.assign(Object.create({ inherited: true }), custom),
	]) {
		await assert.rejects(
			runBackupRuntime(
				env,
				{
					instanceId: event.instanceId,
					payload: invalidPayload,
					timestamp: event.timestamp,
				},
				new TestWorkflowStep(),
				{ payloadKind: 'mailbox-legacy-graph-pre-drop' },
			),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === 'invalid-workflow-payload',
		)
	}
	assert.equal(consoleError.mock.calls.length, 4)
	consoleError.mockRestore()
})
