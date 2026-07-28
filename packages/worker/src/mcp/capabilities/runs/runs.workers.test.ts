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

// Each RunLog Durable Object RPC costs ~400ms in the vitest workers pool (the
// production finish path measures ~0.4ms), and these tests make ~20 of them.
// The shared default is 5s locally, so budget explicitly like the other
// Durable-Object-heavy suites rather than relying on it.
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
			context: baseContext({ surface: 'webhook', name: 'sentry' }),
			status: 'success',
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
	},
	runLogSuiteTimeoutMs,
)

test(
	'run_get exposes bounded metadata.result for webhook deliveries',
	async () => {
		const userId = uniqueUserId('webhook-result')
		const callerContext = buildCallerContext({
			userId,
			email: `${userId}@example.com`,
		})
		const handle = await finishRun({
			userId,
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
		const detail = await runGetCapability.handler(
			{ run_id: handle.id },
			{ env, callerContext },
		)
		expect(detail.run.metadata).toMatchObject({
			endpointId: 'ep-result',
			outcome: 'delivered',
			result: { ok: true, agentId: 'agent-123' },
		})
	},
	runLogSuiteTimeoutMs,
)
