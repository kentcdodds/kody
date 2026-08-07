import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { beginRunRecord, finishRunRecord } from '#worker/run-records/service.ts'
import {
	type RunRecordContext,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'
import { runGetCapability } from './run-get.ts'
import { runListCapability } from './run-list.ts'
import { runSummaryCapability } from './run-summary.ts'
import { runUpdateCapability } from './run-update.ts'

// The first Durable Object class load in a workers-unit file costs ~10s in the
// vitest pool (warm RPCs are ~1ms; production finish is ~0.4ms). These tests
// also issue many RunLog RPCs, so budget well above the shared 20s default
// (decision 0011 — do not try to warm DOs from setupFiles).
const runLogSuiteTimeoutMs = 60_000

// Every test mints a fresh user id, so its RunLog Durable Object starts empty
// and needs no clearing.
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
	result?: unknown
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
		result: input.result,
	})
	return handle
}

test(
	'run capabilities require authentication',
	async () => {
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
		await expect(
			runUpdateCapability.handler(
				{ run_id: 'missing', triage: 'ignored' },
				{ env, callerContext },
			),
		).rejects.toThrow(/Authenticated MCP user/)
	},
	runLogSuiteTimeoutMs,
)

test(
	'run capabilities smoke: list, get, summary, and tenant isolation',
	async () => {
		const ownerId = uniqueUserId('tenant')
		const otherId = uniqueUserId('other')
		const ownerContext = buildCallerContext({
			userId: ownerId,
			email: `${ownerId}@example.com`,
		})
		const otherContext = buildCallerContext({
			userId: otherId,
			email: `${otherId}@example.com`,
		})

		// Seed owner's runs; startedAt offsets ensure stable list order.
		const startedAtBase = Date.now() - 60_000
		const handle = await finishRun({
			userId: ownerId,
			id: 'run-job-err',
			startedAt: new Date(startedAtBase).toISOString(),
			context: baseContext({
				surface: 'job',
				jobId: 'job-a',
				name: 'with-logs',
			}),
			status: 'error',
			error: new Error('boom'),
			logs: ['line-one', 'line-two'],
		})
		await finishRun({
			userId: ownerId,
			id: 'run-webhook',
			startedAt: new Date(startedAtBase + 1000).toISOString(),
			context: baseContext({
				surface: 'webhook',
				name: 'sentry',
				metadata: {
					endpointId: 'ep-result',
					httpStatus: 202,
					outcome: 'delivered',
				},
			}),
			status: 'success',
			result: { ok: true, agentId: 'agent-123' },
		})
		const pending: Array<Promise<unknown>> = []
		beginRunRecord({
			env,
			userId: ownerId,
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

		// run_list: smoke surface filter; other tenant sees empty list.
		const jobRuns = await runListCapability.handler(
			{ surface: 'job' },
			{ env, callerContext: ownerContext },
		)
		expect(jobRuns.runs.some((r) => r.id === 'run-job-err')).toBe(true)
		const otherList = await runListCapability.handler(
			{},
			{ env, callerContext: otherContext },
		)
		expect(otherList.runs).toEqual([])

		// run_get: owner reads own run with logs; other tenant and missing run are rejected.
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
		const webhookDetail = await runGetCapability.handler(
			{ run_id: 'run-webhook' },
			{ env, callerContext: ownerContext },
		)
		expect(webhookDetail.run.metadata).toMatchObject({
			endpointId: 'ep-result',
			outcome: 'delivered',
			result: { ok: true, agentId: 'agent-123' },
		})
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

		// run_summary: owner sees totals including the in-flight workflow run;
		// other tenant sees zeros.
		const summary = await runSummaryCapability.handler(
			{},
			{ env, callerContext: ownerContext },
		)
		expect(summary.total).toBeGreaterThanOrEqual(3)
		expect(summary.errors).toBeGreaterThanOrEqual(1)
		expect(summary.running).toBeGreaterThanOrEqual(1)
		expect(
			summary.by_surface.some(
				(entry) => entry.surface === 'job' && entry.total >= 1,
			),
		).toBe(true)
		const otherSummary = await runSummaryCapability.handler(
			{},
			{ env, callerContext: otherContext },
		)
		expect(otherSummary.total).toBe(0)
		expect(otherSummary.errors).toBe(0)
		expect(otherSummary.ignored).toBe(0)
		expect(otherSummary.resolved).toBe(0)
	},
	runLogSuiteTimeoutMs,
)

test(
	'run_update triage: set/list/filter/summary/reopen and preserve error details',
	async () => {
		const ownerId = uniqueUserId('triage')
		const ownerContext = buildCallerContext({
			userId: ownerId,
			email: `${ownerId}@example.com`,
		})
		const startedAtBase = Date.now() - 60_000
		await finishRun({
			userId: ownerId,
			id: 'err-open',
			startedAt: new Date(startedAtBase).toISOString(),
			context: baseContext({ surface: 'job', name: 'keep-open' }),
			status: 'error',
			error: new Error('still broken'),
		})
		await finishRun({
			userId: ownerId,
			id: 'err-noise',
			startedAt: new Date(startedAtBase + 1000).toISOString(),
			context: baseContext({ surface: 'job', name: 'soft-fail' }),
			status: 'error',
			error: new Error('expected flake'),
		})
		await finishRun({
			userId: ownerId,
			id: 'ok-run',
			startedAt: new Date(startedAtBase + 2000).toISOString(),
			context: baseContext({ surface: 'job', name: 'ok' }),
			status: 'success',
		})

		const ignored = await runUpdateCapability.handler(
			{
				run_id: 'err-noise',
				triage: 'ignored',
				note: 'known flake',
			},
			{ env, callerContext: ownerContext },
		)
		expect(ignored.run).toMatchObject({
			id: 'err-noise',
			status: 'error',
			error_message: 'expected flake',
			error_triage: 'ignored',
			triage_note: 'known flake',
			triaged_by: ownerId,
		})
		expect(ignored.run.triaged_at).toBeTruthy()

		// A later finish must preserve soft triage (INSERT OR REPLACE used to wipe it).
		await finishRun({
			userId: ownerId,
			id: 'err-noise',
			startedAt: new Date(startedAtBase + 1000).toISOString(),
			context: baseContext({ surface: 'job', name: 'soft-fail' }),
			status: 'error',
			error: new Error('expected flake'),
		})
		const afterFinish = await runGetCapability.handler(
			{ run_id: 'err-noise' },
			{ env, callerContext: ownerContext },
		)
		expect(afterFinish.run).toMatchObject({
			error_triage: 'ignored',
			triage_note: 'known flake',
			triaged_by: ownerId,
			error_message: 'expected flake',
		})

		await expect(
			runUpdateCapability.handler(
				{ run_id: 'ok-run', triage: 'resolved' },
				{ env, callerContext: ownerContext },
			),
		).rejects.toThrow(/only error runs/)

		const defaultList = await runListCapability.handler(
			{ status: 'error' },
			{ env, callerContext: ownerContext },
		)
		expect(defaultList.runs.map((run) => run.id)).toEqual(['err-open'])

		const ignoredList = await runListCapability.handler(
			{ error_triage: 'ignored' },
			{ env, callerContext: ownerContext },
		)
		expect(ignoredList.runs.map((run) => run.id)).toEqual(['err-noise'])

		const allList = await runListCapability.handler(
			{ error_triage: 'all', status: 'error' },
			{ env, callerContext: ownerContext },
		)
		expect(allList.runs.map((run) => run.id).sort()).toEqual([
			'err-noise',
			'err-open',
		])

		const resolved = await runUpdateCapability.handler(
			{ run_id: 'err-noise', triage: 'resolved', note: 'fixed upstream' },
			{ env, callerContext: ownerContext },
		)
		expect(resolved.run.error_triage).toBe('resolved')
		expect(resolved.run.triage_note).toBe('fixed upstream')
		expect(resolved.run.error_message).toBe('expected flake')

		// Omitting note must preserve the existing triage note across the DO RPC.
		const keepNote = await runUpdateCapability.handler(
			{ run_id: 'err-noise', triage: 'ignored' },
			{ env, callerContext: ownerContext },
		)
		expect(keepNote.run).toMatchObject({
			error_triage: 'ignored',
			triage_note: 'fixed upstream',
		})

		const summary = await runSummaryCapability.handler(
			{},
			{ env, callerContext: ownerContext },
		)
		expect(summary.errors).toBe(1)
		expect(summary.ignored).toBe(1)
		expect(summary.resolved).toBe(0)

		const reopened = await runUpdateCapability.handler(
			{ run_id: 'err-noise', triage: 'open' },
			{ env, callerContext: ownerContext },
		)
		expect(reopened.run).toMatchObject({
			error_triage: null,
			triage_note: null,
			triaged_at: null,
			triaged_by: null,
			error_message: 'expected flake',
		})

		const afterReopen = await runSummaryCapability.handler(
			{},
			{ env, callerContext: ownerContext },
		)
		expect(afterReopen.errors).toBe(2)
		expect(afterReopen.ignored).toBe(0)
		expect(afterReopen.resolved).toBe(0)

		const detail = await runGetCapability.handler(
			{ run_id: 'err-noise' },
			{ env, callerContext: ownerContext },
		)
		expect(detail.run.error_triage).toBeNull()
		expect(detail.run.error_message).toBe('expected flake')
	},
	runLogSuiteTimeoutMs,
)
