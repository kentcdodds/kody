import assert from 'node:assert/strict'

import { test } from 'vitest'

import { runDurableExport } from './durable-export.ts'
import { BackupError, backupPayload } from './backup-policy.ts'
import {
	enqueueBackupRetry,
	primaryBackupTimeForDay,
} from './workflow-trigger.ts'
import {
	ReplayStep,
	environment,
	exportEnvelope,
} from './backup-control-plane-test-support.ts'

test('durable orchestration starts once and resumes numbered polls after interruption', async () => {
	const bodies: string[] = []
	const responses = [
		exportEnvelope(),
		exportEnvelope(),
		exportEnvelope('complete'),
	]
	const step = new ReplayStep('poll-d1-export-1')
	const options = {
		maxPolls: 3,
		pollIntervalSeconds: 1,
		api: {
			fetcher: async (_input: RequestInfo | URL, init?: RequestInit) => {
				bodies.push(String(init?.body))
				return responses.shift()!
			},
			sleep: async () => undefined,
		},
	}
	await assert.rejects(runDurableExport(environment(), step, options))
	const result = await runDurableExport(environment(), step, options)
	assert.equal(result.bookmark, 'bookmark-1')
	assert.equal(
		step.executions.filter((name) => name === 'start-d1-export').length,
		1,
	)
	assert.equal(bodies.length, 3, 'cached start must not call the API on replay')
	assert.deepEqual(JSON.parse(bodies[0]!), { output_format: 'polling' })
	assert.deepEqual(JSON.parse(bodies[1]!), {
		output_format: 'polling',
		current_bookmark: 'bookmark-1',
	})
	assert.deepEqual(step.sleeps, [
		'wait-d1-export-1',
		'wait-d1-export-1',
		'wait-d1-export-2',
	])
})

test('durable polling hard-fails after its bounded numbered poll steps', async () => {
	const step = new ReplayStep()
	await assert.rejects(
		runDurableExport(environment(), step, {
			maxPolls: 2,
			pollIntervalSeconds: 1,
			api: {
				fetcher: async () => exportEnvelope(),
				sleep: async () => undefined,
			},
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'export-poll-limit' &&
			error.retryable === false,
	)
	assert.deepEqual(step.calls, [
		'start-d1-export',
		'poll-d1-export-1',
		'poll-d1-export-2',
	])
})

test('scheduled restart after poll exhaustion starts a new export state', async () => {
	let workflowStatus: 'running' | 'errored' = 'running'
	await assert.rejects(
		runDurableExport(environment(), new ReplayStep(), {
			maxPolls: 2,
			pollIntervalSeconds: 1,
			api: {
				fetcher: async () => exportEnvelope(),
				sleep: async () => undefined,
			},
		}),
		(error: unknown) => {
			const exhausted =
				error instanceof BackupError &&
				error.code === 'export-poll-limit' &&
				error.retryable === false
			if (exhausted) workflowStatus = 'errored'
			return exhausted
		},
	)
	assert.equal(workflowStatus, 'errored')

	let restarts = 0
	const workflow = {
		async create() {
			throw new Error('instance already exists')
		},
		async get() {
			return {
				status: async () => ({ status: workflowStatus }),
				restart: async () => {
					restarts += 1
					workflowStatus = 'running'
				},
			}
		},
	}
	const tick = new Date('2026-07-22T03:45:00Z')
	assert.equal(
		await enqueueBackupRetry(
			workflow,
			environment().SOURCE_DATABASE_ID,
			backupPayload(environment(), primaryBackupTimeForDay(tick)),
			tick,
		),
		'restarted',
	)
	assert.equal(restarts, 1)
	assert.equal(workflowStatus, 'running')

	const requestBodies: unknown[] = []
	const result = await runDurableExport(environment(), new ReplayStep(), {
		maxPolls: 2,
		pollIntervalSeconds: 1,
		api: {
			fetcher: async (_input, init) => {
				requestBodies.push(JSON.parse(String(init?.body)))
				return exportEnvelope('complete', 'bookmark-new')
			},
			sleep: async () => undefined,
		},
	})
	assert.equal(result.bookmark, 'bookmark-new')
	assert.deepEqual(requestBodies, [{ output_format: 'polling' }])
})
