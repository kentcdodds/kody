import assert from 'node:assert/strict'

import { test } from 'vitest'

import { BackupError, backupPayload } from './backup-policy.ts'
import { type BackupPayload } from './backup-types.ts'
import {
	enqueueBackup,
	isApprovedRetryWindow,
	retryExistingBackup,
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

for (const status of [
	'queued',
	'running',
	'paused',
	'complete',
	'waiting',
	'waitingForPause',
] as const) {
	test(`${status} workflow instances are not restarted`, async () => {
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
		assert.equal(
			await enqueueBackup(
				workflow,
				DATABASE_ID,
				backupPayload(environment(), new Date('2026-07-22T02:15:00Z')),
			),
			'duplicate',
		)
		assert.equal(restarts, 0)
	})
}

for (const status of ['errored', 'terminated'] as const) {
	test(`${status} workflow instances are restarted once`, async () => {
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
		assert.equal(
			await enqueueBackup(
				workflow,
				DATABASE_ID,
				backupPayload(environment(), new Date('2026-07-22T02:15:00Z')),
			),
			'restarted',
		)
		assert.equal(restarts, 1)
	})
}

for (const status of ['unknown', 'unexpected'] as const) {
	test(`${status} workflow status fails closed`, async () => {
		let restarts = 0
		const workflow = {
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
		}
		await assert.rejects(
			enqueueBackup(
				workflow,
				DATABASE_ID,
				backupPayload(environment(), new Date('2026-07-22T02:15:00Z')),
			),
			/original create failure/,
		)
		assert.equal(restarts, 0)
	})
}

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

test('existing-only retry restarts a later failure without creating', async () => {
	let creates = 0
	let restarts = 0
	const workflow = {
		async create() {
			creates += 1
		},
		async get() {
			return {
				status: async () => ({ status: 'errored' as const }),
				restart: async () => {
					restarts += 1
				},
			}
		},
	}
	assert.equal(
		await retryExistingBackup(workflow, DATABASE_ID, '2026-07-22'),
		'restarted',
	)
	assert.equal(creates, 0)
	assert.equal(restarts, 1)
})

test('existing-only retry does not create a missing deterministic instance', async () => {
	let creates = 0
	const workflow = {
		async create() {
			creates += 1
		},
		async get() {
			throw new Error('instance missing')
		},
	}
	assert.equal(
		await retryExistingBackup(workflow, DATABASE_ID, '2026-07-22'),
		'missing',
	)
	assert.equal(creates, 0)
})

test('existing-only retry leaves active/complete alone and fails closed on unknown', async () => {
	for (const status of ['running', 'complete'] as const) {
		let restarts = 0
		const workflow = {
			async get() {
				return {
					status: async () => ({ status }),
					restart: async () => {
						restarts += 1
					},
				}
			},
		}
		assert.equal(
			await retryExistingBackup(workflow, DATABASE_ID, '2026-07-22'),
			'duplicate',
		)
		assert.equal(restarts, 0)
	}
	await assert.rejects(
		retryExistingBackup(
			{
				async get() {
					return {
						status: async () => ({ status: 'unknown' as const }),
						restart: async () => undefined,
					}
				},
			},
			DATABASE_ID,
			'2026-07-22',
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'workflow-status-unknown',
	)
})
