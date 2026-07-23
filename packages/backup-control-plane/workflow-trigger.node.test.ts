import assert from 'node:assert/strict'

import { test } from 'vitest'

import { backupPayload } from './backup-policy.ts'
import { type BackupPayload } from './backup-types.ts'
import {
	enqueueBackup,
	enqueueBackupRetry,
	isApprovedRetryWindow,
	primaryBackupTimeForDay,
	type WorkflowInstanceStatus,
} from './workflow-trigger.ts'
import {
	DATABASE_ID,
	environment,
} from './backup-control-plane-test-support.ts'

test('workflow creation omits explicit retention and active overlap stays duplicate', async () => {
	let createdOptions: { id: string; params: BackupPayload } | undefined
	const workflow = {
		async create(options: { id: string; params: BackupPayload }) {
			if (createdOptions) throw new Error('instance already exists')
			createdOptions = options
		},
		async get() {
			return {
				status: async () => ({ status: 'running' as const }),
				restart: async () => undefined,
			}
		},
	}
	const payload = backupPayload(environment(), new Date('2026-07-22T02:15:00Z'))
	assert.equal(await enqueueBackup(workflow, DATABASE_ID, payload), 'created')
	assert.equal('retention' in createdOptions!, false)
	assert.equal(await enqueueBackup(workflow, DATABASE_ID, payload), 'duplicate')
})

test('enqueueBackup status matrix: leave active alone, restart failed, fail closed', async () => {
	const payload = backupPayload(environment(), new Date('2026-07-22T02:15:00Z'))
	for (const status of [
		'queued',
		'running',
		'paused',
		'complete',
		'waiting',
		'waitingForPause',
	] as const) {
		let restarts = 0
		assert.equal(
			await enqueueBackup(
				{
					async create() {
						throw new Error('instance already exists')
					},
					async get() {
						return {
							status: async () => ({ status }),
							restart: async () => {
								restarts += 1
							},
						}
					},
				},
				DATABASE_ID,
				payload,
			),
			'duplicate',
		)
		assert.equal(restarts, 0)
	}

	for (const status of ['errored', 'terminated'] as const) {
		let restarts = 0
		assert.equal(
			await enqueueBackup(
				{
					async create() {
						throw new Error('instance already exists')
					},
					async get() {
						return {
							status: async () => ({ status }),
							restart: async () => {
								restarts += 1
							},
						}
					},
				},
				DATABASE_ID,
				payload,
			),
			'restarted',
		)
		assert.equal(restarts, 1)
	}

	for (const status of ['unknown', 'unexpected'] as const) {
		let restarts = 0
		await assert.rejects(
			enqueueBackup(
				{
					async create() {
						throw new Error('original create failure')
					},
					async get() {
						return {
							status: async () => ({
								status: status as WorkflowInstanceStatus,
							}),
							restart: async () => {
								restarts += 1
							},
						}
					},
				},
				DATABASE_ID,
				payload,
			),
			/original create failure/,
		)
		assert.equal(restarts, 0)
	}
})

test('hourly freshness retries are bounded to 02:45 through 05:45 UTC', () => {
	for (const hour of [2, 3, 4, 5]) {
		assert.equal(
			isApprovedRetryWindow(
				new Date(`2026-07-22T${String(hour).padStart(2, '0')}:45:00Z`),
			),
			true,
		)
	}
	assert.equal(isApprovedRetryWindow(new Date('2026-07-22T01:45:00Z')), false)
	assert.equal(isApprovedRetryWindow(new Date('2026-07-22T06:45:00Z')), false)
	assert.equal(isApprovedRetryWindow(new Date('2026-07-22T03:44:00Z')), false)
})

test('missed 02:15 creation is caught up with the canonical payload', async () => {
	let creates = 0
	let created: { id: string; params: BackupPayload } | undefined
	const workflow = {
		async create(options: { id: string; params: BackupPayload }) {
			creates += 1
			created = options
		},
		async get() {
			throw new Error('instance missing')
		},
	}
	const tick = new Date('2026-07-22T02:45:00Z')
	const payload = backupPayload(environment(), primaryBackupTimeForDay(tick))
	assert.equal(
		await enqueueBackupRetry(workflow, DATABASE_ID, payload, tick),
		'created',
	)
	assert.equal(creates, 1)
	assert.equal(created?.params.scheduledAt, '2026-07-22T02:15:00.000Z')
	assert.equal(created?.id, `d1-backup-${DATABASE_ID}-2026-07-22`)
})

test('concurrent retry ticks idempotently create one deterministic instance', async () => {
	let creates = 0
	let exists = false
	const workflow = {
		async create() {
			await Promise.resolve()
			if (exists) throw new Error('instance already exists')
			exists = true
			creates += 1
		},
		async get() {
			return {
				status: async () => ({ status: 'running' as const }),
				restart: async () => undefined,
			}
		},
	}
	const tick = new Date('2026-07-22T03:45:00Z')
	const payload = backupPayload(environment(), primaryBackupTimeForDay(tick))
	assert.deepEqual(
		(
			await Promise.all([
				enqueueBackupRetry(workflow, DATABASE_ID, payload, tick),
				enqueueBackupRetry(workflow, DATABASE_ID, payload, tick),
			])
		).sort(),
		['created', 'duplicate'],
	)
	assert.equal(creates, 1)
})

test('outside-window retry never creates a missing instance', async () => {
	let creates = 0
	const workflow = {
		async create() {
			creates += 1
		},
		async get() {
			throw new Error('instance missing')
		},
	}
	const tick = new Date('2026-07-22T06:45:00Z')
	const payload = backupPayload(environment(), primaryBackupTimeForDay(tick))
	assert.equal(
		await enqueueBackupRetry(workflow, DATABASE_ID, payload, tick),
		'outside-window',
	)
	assert.equal(creates, 0)
})

test('retry ticks leave active/complete alone and fail closed on unknown', async () => {
	for (const status of ['running', 'complete'] as const) {
		let restarts = 0
		const workflow = {
			async create() {
				throw new Error('instance already exists')
			},
			async get() {
				return {
					status: async () => ({ status }),
					restart: async () => {
						restarts += 1
					},
				}
			},
		}
		const tick = new Date('2026-07-22T03:45:00Z')
		assert.equal(
			await enqueueBackupRetry(
				workflow,
				DATABASE_ID,
				backupPayload(environment(), primaryBackupTimeForDay(tick)),
				tick,
			),
			'duplicate',
		)
		assert.equal(restarts, 0)
	}
	await assert.rejects(
		enqueueBackupRetry(
			{
				async create() {
					throw new Error('instance already exists')
				},
				async get() {
					return {
						status: async () => ({ status: 'unknown' as const }),
						restart: async () => undefined,
					}
				},
			},
			DATABASE_ID,
			backupPayload(
				environment(),
				primaryBackupTimeForDay(new Date('2026-07-22T03:45:00Z')),
			),
			new Date('2026-07-22T03:45:00Z'),
		),
		(error: unknown) =>
			error instanceof Error && /instance already exists/.test(error.message),
	)
})
