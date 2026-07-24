import assert from 'node:assert/strict'

import { test } from 'vitest'

import { runDurableExport } from './durable-export.ts'
import { BackupError } from './backup-policy.ts'
import {
	ReplayStep,
	environment,
	exportEnvelope,
} from './backup-control-plane-test-support.ts'

test('durable orchestration polls immediately then resumes numbered polls after interruption', async () => {
	const bodies: string[] = []
	const responses = [
		exportEnvelope('active'),
		exportEnvelope('active'),
		exportEnvelope('complete'),
	]
	const step = new ReplayStep('poll-d1-export-1')
	const options = {
		maxPolls: 3,
		pollIntervalSeconds: 15,
		earlyPollIntervalSeconds: 2,
		earlyPollCount: 5,
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
	// Immediate first poll (no wait before poll-1); wait only after a pending poll.
	assert.deepEqual(step.sleeps, ['wait-d1-export-1'])
})

test('durable polling hard-fails after its bounded numbered poll steps', async () => {
	const step = new ReplayStep()
	await assert.rejects(
		runDurableExport(environment(), step, {
			maxPolls: 2,
			pollIntervalSeconds: 1,
			earlyPollIntervalSeconds: 1,
			api: {
				fetcher: async () => exportEnvelope('active'),
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

test('expired poll result restarts the export with a new bookmark', async () => {
	const bodies: unknown[] = []
	const responses = [
		exportEnvelope('active', 'bookmark-old'),
		exportEnvelope('lost'),
		exportEnvelope('active', 'bookmark-new'),
		exportEnvelope('complete', 'bookmark-new'),
	]
	const result = await runDurableExport(environment(), new ReplayStep(), {
		maxPolls: 5,
		pollIntervalSeconds: 15,
		earlyPollIntervalSeconds: 2,
		api: {
			fetcher: async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body)))
				return responses.shift()!
			},
			sleep: async () => undefined,
		},
	})
	assert.equal(result.bookmark, 'bookmark-new')
	assert.deepEqual(bodies, [
		{ output_format: 'polling' },
		{
			output_format: 'polling',
			current_bookmark: 'bookmark-old',
		},
		{ output_format: 'polling' },
		{
			output_format: 'polling',
			current_bookmark: 'bookmark-new',
		},
	])
})
