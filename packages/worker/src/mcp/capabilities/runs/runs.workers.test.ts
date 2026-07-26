import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	beginRunRecord,
	clearRunRecords,
	finishRunRecord,
} from '#worker/run-records/service.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { runGetCapability } from './run-get.ts'
import { runListCapability } from './run-list.ts'
import { runSummaryCapability } from './run-summary.ts'

function uniqueUserId(label: string) {
	return `runs-cap-${label}-${crypto.randomUUID()}`
}

function buildCallerContext(user: { userId: string; email: string } | null) {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		...(user
			? {
					user: {
						...user,
						displayName: 'Runs Tester',
					},
				}
			: {}),
	})
}

function baseContext(overrides?: Partial<RunRecordContext>): RunRecordContext {
	return {
		surface: 'job',
		name: 'example-job',
		...overrides,
	}
}

async function finishRun(input: {
	userId: string
	id?: string
	context: RunRecordContext
	status: 'success' | 'error'
	startedAt?: string
	logs?: Array<string>
	error?: unknown
}) {
	const handle: RunRecordHandle = {
		id: input.id ?? crypto.randomUUID(),
		userId: input.userId,
		startedAt: input.startedAt ?? new Date().toISOString(),
		persistence: 'eager',
		context: input.context,
	}
	await finishRunRecord({
		env,
		handle,
		status: input.status,
		logs: input.logs,
		error: input.error,
	})
	return handle
}

test('run capabilities require authentication', async () => {
	const callerContext = buildCallerContext(null)
	await expect(
		runListCapability.handler({}, { env, callerContext }),
	).rejects.toThrow(/Authenticated MCP user/)
	await expect(
		runGetCapability.handler({ run_id: 'missing' }, { env, callerContext }),
	).rejects.toThrow(/Authenticated MCP user/)
	await expect(
		runSummaryCapability.handler({}, { env, callerContext }),
	).rejects.toThrow(/Authenticated MCP user/)
})

test('run_list filters by surface/status/job and paginates with cursors', async () => {
	const userId = uniqueUserId('list')
	const callerContext = buildCallerContext({
		userId,
		email: `${userId}@example.com`,
	})
	await clearRunRecords({ env, userId })

	const startedAtBase = Date.now() - 60_000
	await finishRun({
		userId,
		id: 'run-job-ok',
		startedAt: new Date(startedAtBase).toISOString(),
		context: baseContext({
			surface: 'job',
			jobId: 'job-a',
			name: 'job-a',
		}),
		status: 'success',
	})
	await finishRun({
		userId,
		id: 'run-job-err',
		startedAt: new Date(startedAtBase + 1000).toISOString(),
		context: baseContext({
			surface: 'job',
			jobId: 'job-a',
			name: 'job-a-fail',
		}),
		status: 'error',
		error: new Error('boom'),
		logs: ['failed'],
	})
	await finishRun({
		userId,
		id: 'run-webhook',
		startedAt: new Date(startedAtBase + 2000).toISOString(),
		context: baseContext({
			surface: 'webhook',
			name: 'sentry',
			metadata: {
				outcome: 'delivered',
				http_status: 202,
				payload_bytes: 8,
			},
		}),
		status: 'success',
	})
	await finishRun({
		userId,
		id: 'run-job-b',
		startedAt: new Date(startedAtBase + 3000).toISOString(),
		context: baseContext({
			surface: 'job',
			jobId: 'job-b',
			name: 'job-b',
		}),
		status: 'success',
	})

	const jobs = await runListCapability.handler(
		{ surface: 'job' },
		{ env, callerContext },
	)
	expect(jobs.runs.map((run) => run.id)).toEqual([
		'run-job-b',
		'run-job-err',
		'run-job-ok',
	])

	const errors = await runListCapability.handler(
		{ status: 'error' },
		{ env, callerContext },
	)
	expect(errors.runs.map((run) => run.id)).toEqual(['run-job-err'])
	expect(errors.runs[0]?.error_message).toBe('boom')

	const jobA = await runListCapability.handler(
		{ job_id: 'job-a' },
		{ env, callerContext },
	)
	expect(jobA.runs.map((run) => run.id)).toEqual(['run-job-err', 'run-job-ok'])

	const page1 = await runListCapability.handler(
		{ limit: 2 },
		{ env, callerContext },
	)
	expect(page1.runs.map((run) => run.id)).toEqual(['run-job-b', 'run-webhook'])
	expect(page1.next_cursor).toEqual(expect.any(String))
	const page2 = await runListCapability.handler(
		{ limit: 2, cursor: page1.next_cursor ?? undefined },
		{ env, callerContext },
	)
	expect(page2.runs.map((run) => run.id)).toEqual(['run-job-err', 'run-job-ok'])
}, 15_000)

test('run_get returns logs and rejects missing or foreign runs', async () => {
	const ownerId = uniqueUserId('owner')
	const otherId = uniqueUserId('other')
	const ownerContext = buildCallerContext({
		userId: ownerId,
		email: `${ownerId}@example.com`,
	})
	const otherContext = buildCallerContext({
		userId: otherId,
		email: `${otherId}@example.com`,
	})
	await clearRunRecords({ env, userId: ownerId })
	await clearRunRecords({ env, userId: otherId })

	const handle = await finishRun({
		userId: ownerId,
		context: baseContext({
			surface: 'job',
			jobId: 'job-logs',
			name: 'with-logs',
		}),
		status: 'error',
		error: new Error('explode'),
		logs: ['line-one', 'line-two'],
	})

	const detail = await runGetCapability.handler(
		{ run_id: handle.id },
		{ env, callerContext: ownerContext },
	)
	expect(detail.run.id).toBe(handle.id)
	expect(detail.run.status).toBe('error')
	expect(detail.logs.map((log) => log.message)).toEqual([
		'line-one',
		'line-two',
	])

	await expect(
		runGetCapability.handler(
			{ run_id: handle.id },
			{ env, callerContext: otherContext },
		),
	).rejects.toThrow(/was not found/)

	await expect(
		runGetCapability.handler(
			{ run_id: crypto.randomUUID() },
			{ env, callerContext: ownerContext },
		),
	).rejects.toThrow(/was not found/)
})

test('run_summary counts totals, errors, running, and surfaces', async () => {
	const userId = uniqueUserId('summary')
	const callerContext = buildCallerContext({
		userId,
		email: `${userId}@example.com`,
	})
	await clearRunRecords({ env, userId })

	await finishRun({
		userId,
		context: baseContext({ surface: 'job', jobId: 'job-1' }),
		status: 'success',
	})
	await finishRun({
		userId,
		context: baseContext({ surface: 'job', jobId: 'job-2' }),
		status: 'error',
		error: new Error('fail'),
	})
	await finishRun({
		userId,
		context: baseContext({
			surface: 'webhook',
			name: 'hook',
		}),
		status: 'success',
	})
	const pending: Array<Promise<unknown>> = []
	beginRunRecord({
		env,
		userId,
		context: baseContext({
			surface: 'workflow',
			workflowId: 'wf-running',
			name: 'still-going',
		}),
		waitUntil: (promise) => {
			pending.push(promise)
		},
	})
	await Promise.all(pending)

	const summary = await runSummaryCapability.handler({}, { env, callerContext })
	expect(summary.total).toBeGreaterThanOrEqual(4)
	expect(summary.errors).toBeGreaterThanOrEqual(1)
	expect(summary.running).toBeGreaterThanOrEqual(1)
	expect(
		summary.by_surface.some(
			(entry) =>
				entry.surface === 'job' && entry.total >= 2 && entry.errors >= 1,
		),
	).toBe(true)
	expect(
		summary.by_surface.some(
			(entry) => entry.surface === 'webhook' && entry.total >= 1,
		),
	).toBe(true)
})

test('run_list cannot read another users records', async () => {
	const ownerId = uniqueUserId('iso-owner')
	const otherId = uniqueUserId('iso-other')
	const ownerContext = buildCallerContext({
		userId: ownerId,
		email: `${ownerId}@example.com`,
	})
	const otherContext = buildCallerContext({
		userId: otherId,
		email: `${otherId}@example.com`,
	})
	await clearRunRecords({ env, userId: ownerId })
	await clearRunRecords({ env, userId: otherId })

	await finishRun({
		userId: ownerId,
		context: baseContext({ surface: 'job', jobId: 'secret-job' }),
		status: 'error',
		error: new Error('owner-only'),
	})

	const ownerList = await runListCapability.handler(
		{},
		{ env, callerContext: ownerContext },
	)
	expect(ownerList.runs.some((run) => run.job_id === 'secret-job')).toBe(true)

	const otherList = await runListCapability.handler(
		{},
		{ env, callerContext: otherContext },
	)
	expect(otherList.runs).toEqual([])

	const otherSummary = await runSummaryCapability.handler(
		{},
		{ env, callerContext: otherContext },
	)
	expect(otherSummary.total).toBe(0)
	expect(otherSummary.errors).toBe(0)
})
