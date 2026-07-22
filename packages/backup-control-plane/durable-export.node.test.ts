import assert from 'node:assert/strict'

import { test } from 'vitest'

import { runDurableExport } from './durable-export.ts'
import { BackupError } from './backup-policy.ts'
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
			error instanceof BackupError && error.code === 'export-poll-limit',
	)
	assert.deepEqual(step.calls, [
		'start-d1-export',
		'poll-d1-export-1',
		'poll-d1-export-2',
	])
})
