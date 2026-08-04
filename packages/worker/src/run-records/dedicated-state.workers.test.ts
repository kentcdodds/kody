import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { RunLog } from './run-log-do.ts'
import {
	beginRunRecord,
	claimPackageInvocationRecord,
	clearRunRecords,
	countActiveWorkflowProjections,
	exportRunRecords,
	findWorkflowProjectionByBindingIdempotencyKey,
	findWorkflowProjectionByIdempotencyKey,
	finishPackageInvocationRecord,
	finishRunRecord,
	getAdminInsightsSnapshot,
	getJobRunObservability,
	getJobRunObservabilityBatch,
	getWorkflowProjection,
	listActivationMilestones,
	listPackageRunSuccesses,
	listRunRecords,
	listWorkflowProjections,
	reserveWorkflowProjectionSlot,
	deleteWorkflowProjectionIfCreating,
	upsertJobRunObservability,
	upsertWorkflowProjection,
	workflowProjectionCreatingTtlMs,
} from './service.ts'
import {
	runRecordMaxRunsPerUser,
	runRecordRetentionEveryNFinishes,
	type RunRecordContext,
} from './types.ts'

function uniqueUserId(label: string) {
	return `runlog-dedicated-${label}-${crypto.randomUUID()}`
}

function silenceExpectedConsoleWarns(substrings: Array<string>) {
	silenceIncidentalRuntimeWarnings()
	consoleWarn.mockImplementation((...args: Array<unknown>) => {
		const message = String(args[0] ?? '')
		if (substrings.some((part) => message.includes(part))) return
	})
}

async function armRetentionOnNextFinish(userId: string, runCount?: number) {
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			'finishes_since_retention',
			runRecordRetentionEveryNFinishes - 1,
		)
		if (typeof runCount === 'number') {
			state.storage.sql.exec(
				`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				'run_count',
				runCount,
			)
		}
	})
}

function insertAgedRun(
	state: DurableObjectState,
	input: { id: string; startedAt: string },
) {
	state.storage.sql.exec(
		`INSERT INTO runs (
			id, surface, status, name, package_id, package_kody_id, source_id,
			published_commit, storage_id, job_id, workflow_id, invocation_id,
			session_id, idempotency_key, parent_run_id, started_at, finished_at,
			duration_ms, error_name, error_message, metadata_json, created_at,
			updated_at
		) VALUES (?, 'job', 'success', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
			NULL, NULL, NULL, NULL, NULL, ?, ?, 1, NULL, NULL, '{}', ?, ?)`,
		input.id,
		input.startedAt,
		input.startedAt,
		input.startedAt,
		input.startedAt,
	)
}

test('workflow projections track binding name, idempotency, and active counts', async () => {
	const userId = uniqueUserId('workflows')
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-active-1',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'package',
			packageId: 'pkg-1',
			kodyId: 'kody-1',
			sourceId: 'src-1',
			workflowName: 'nightly',
			exportName: 'run',
			idempotencyKey: 'idem-nightly',
			runAt: '2026-07-31T00:00:00.000Z',
			status: 'running',
		},
	})
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-creating',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'adhoc',
			idempotencyKey: 'idem-creating',
			runAt: '2026-07-31T01:00:00.000Z',
			status: 'creating',
		},
	})
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-done',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'package',
			packageId: 'pkg-1',
			workflowName: 'nightly',
			exportName: 'run',
			idempotencyKey: 'idem-done',
			runAt: '2026-07-30T00:00:00.000Z',
			status: 'complete',
			completedAt: '2026-07-30T00:01:00.000Z',
		},
	})

	const got = await getWorkflowProjection({
		env,
		userId,
		id: 'wf-active-1',
	})
	expect(got).toMatchObject({
		id: 'wf-active-1',
		bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		workflowName: 'nightly',
		status: 'running',
		packageId: 'pkg-1',
	})

	expect(
		await findWorkflowProjectionByIdempotencyKey({
			env,
			userId,
			idempotencyKey: 'idem-nightly',
		}),
	).toMatchObject({ id: 'wf-active-1' })
	expect(
		await findWorkflowProjectionByIdempotencyKey({
			env,
			userId,
			idempotencyKey: 'idem-creating',
		}),
	).toBeNull()
	expect(
		await findWorkflowProjectionByIdempotencyKey({
			env,
			userId,
			idempotencyKey: 'idem-creating',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		}),
	).toBeNull()
	expect(
		await findWorkflowProjectionByBindingIdempotencyKey({
			env,
			userId,
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			idempotencyKey: 'idem-creating',
		}),
	).toMatchObject({
		id: 'wf-creating',
		status: 'creating',
		idempotencyKey: 'idem-creating',
	})
	expect(
		await findWorkflowProjectionByBindingIdempotencyKey({
			env,
			userId,
			bindingName: 'OTHER_WORKFLOWS',
			idempotencyKey: 'idem-creating',
		}),
	).toBeNull()

	expect(await countActiveWorkflowProjections({ env, userId })).toBe(1)

	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-active-1',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'package',
			packageId: 'pkg-1',
			workflowName: 'nightly',
			exportName: 'run',
			idempotencyKey: 'idem-nightly',
			runAt: '2026-07-31T00:00:00.000Z',
			status: 'queued',
		},
	})
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-active-2',
			bindingName: 'OTHER_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'other',
			idempotencyKey: 'idem-other',
			runAt: '2026-07-31T02:00:00.000Z',
			status: 'waiting',
		},
	})
	expect(await countActiveWorkflowProjections({ env, userId })).toBe(2)

	const listed = await listWorkflowProjections({ env, userId, limit: 10 })
	expect(listed.projections.map((row) => row.id).sort()).toEqual([
		'wf-active-1',
		'wf-active-2',
		'wf-creating',
		'wf-done',
	])
	expect(
		listed.projections.find((row) => row.id === 'wf-active-2')?.bindingName,
	).toBe('OTHER_WORKFLOWS')
})

test('reserveWorkflowProjectionSlot serializes concurrent creating, prunes stale, and never overwrites terminal', async () => {
	const userId = uniqueUserId('wf-reserve')
	const results = await Promise.all(
		Array.from({ length: 5 }, (_, index) =>
			reserveWorkflowProjectionSlot({
				env,
				userId,
				projection: {
					id: `wf-reserve-${index}`,
					bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
					sourceType: 'inline',
					workflowName: 'adhoc',
					idempotencyKey: `reserve-key-${index}`,
					runAt: '2026-07-31T00:00:00.000Z',
					status: 'creating',
				},
			}),
		),
	)
	const counts = results
		.map((result) => result.countBeforeReservation)
		.sort((left, right) => left - right)
	expect(counts).toEqual([0, 1, 2, 3, 4])
	expect(results.every((result) => result.reserved && result.inserted)).toBe(
		true,
	)

	const oneSlotLimit = 1
	await Promise.all(
		results.map(async (result) => {
			if (result.countBeforeReservation + 1 > oneSlotLimit) {
				await deleteWorkflowProjectionIfCreating({
					env,
					userId,
					id: result.projection.id,
				})
			}
		}),
	)
	const remaining = await listWorkflowProjections({
		env,
		userId,
		status: 'creating',
		limit: 10,
	})
	expect(remaining.projections).toHaveLength(1)
	expect(remaining.projections[0]?.id).toBe(
		results.find((result) => result.countBeforeReservation === 0)?.projection
			.id,
	)

	const ttlUserId = uniqueUserId('wf-reserve-ttl')
	const staleAt = new Date(
		Date.now() - workflowProjectionCreatingTtlMs - 60_000,
	).toISOString()

	await upsertWorkflowProjection({
		env,
		userId: ttlUserId,
		projection: {
			id: 'wf-stale-creating',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'stale',
			idempotencyKey: 'stale-creating-key',
			runAt: staleAt,
			status: 'creating',
			createdAt: staleAt,
			updatedAt: staleAt,
		},
	})
	await upsertWorkflowProjection({
		env,
		userId: ttlUserId,
		projection: {
			id: 'wf-terminal',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'done',
			idempotencyKey: 'terminal-key',
			runAt: '2026-07-31T00:00:00.000Z',
			status: 'complete',
			createdAt: '2026-07-31T00:00:00.000Z',
			updatedAt: '2026-07-31T00:00:00.000Z',
			completedAt: '2026-07-31T00:00:00.000Z',
		},
	})

	const recovered = await reserveWorkflowProjectionSlot({
		env,
		userId: ttlUserId,
		projection: {
			id: 'wf-fresh',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'fresh',
			idempotencyKey: 'fresh-key',
			runAt: '2026-07-31T01:00:00.000Z',
			status: 'creating',
		},
	})
	// Stale creating pruned before count, so the fresh reserve sees an empty slot.
	expect(recovered.countBeforeReservation).toBe(0)
	expect(recovered).toMatchObject({ reserved: true, inserted: true })
	expect(
		await getWorkflowProjection({
			env,
			userId: ttlUserId,
			id: 'wf-stale-creating',
		}),
	).toBeNull()

	const againstTerminal = await reserveWorkflowProjectionSlot({
		env,
		userId: ttlUserId,
		projection: {
			id: 'wf-terminal',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'should-not-clobber',
			idempotencyKey: 'terminal-key',
			runAt: '2026-07-31T02:00:00.000Z',
			status: 'creating',
		},
	})
	expect(againstTerminal).toMatchObject({
		reserved: false,
		inserted: false,
		projection: expect.objectContaining({
			id: 'wf-terminal',
			status: 'complete',
			workflowName: 'done',
		}),
	})

	const sameId = await reserveWorkflowProjectionSlot({
		env,
		userId: ttlUserId,
		projection: {
			id: 'wf-fresh',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'fresh',
			idempotencyKey: 'fresh-key',
			runAt: '2026-07-31T01:00:00.000Z',
			status: 'creating',
		},
	})
	expect(sameId.countBeforeReservation).toBe(0)
	expect(sameId).toMatchObject({ reserved: true, inserted: false })
})

test('workflow projection upsert keeps terminal status sticky against newer active/creating', async () => {
	const userId = uniqueUserId('wf-terminal-sticky')
	const terminalAt = '2026-07-31T20:00:00.000Z'
	const newerAt = '2026-07-31T20:00:01.000Z'

	for (const terminalStatus of ['cancelled', 'complete'] as const) {
		const id = `wf-${terminalStatus}`
		await upsertWorkflowProjection({
			env,
			userId,
			projection: {
				id,
				bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
				sourceType: 'inline',
				workflowName: 'adhoc',
				idempotencyKey: `${terminalStatus}-key`,
				runAt: terminalAt,
				status: terminalStatus,
				createdAt: terminalAt,
				updatedAt: terminalAt,
				completedAt: terminalAt,
			},
		})

		for (const regressStatus of ['queued', 'running', 'creating'] as const) {
			await upsertWorkflowProjection({
				env,
				userId,
				projection: {
					id,
					bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
					sourceType: 'inline',
					workflowName: 'adhoc',
					idempotencyKey: `${terminalStatus}-key`,
					runAt: newerAt,
					status: regressStatus,
					createdAt: terminalAt,
					updatedAt: newerAt,
					completedAt: null,
				},
			})
			expect(await getWorkflowProjection({ env, userId, id })).toMatchObject({
				status: terminalStatus,
				updatedAt: terminalAt,
				completedAt: terminalAt,
			})
		}
	}

	// Terminal → terminal with a newer updatedAt remains allowed.
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-cancelled',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'adhoc',
			idempotencyKey: 'cancelled-key',
			runAt: terminalAt,
			status: 'complete',
			createdAt: terminalAt,
			updatedAt: newerAt,
			completedAt: newerAt,
		},
	})
	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-cancelled' }),
	).toMatchObject({
		status: 'complete',
		updatedAt: newerAt,
		completedAt: newerAt,
	})
})

test('job run observability upserts terminal outcomes and supports batch reads', async () => {
	const userId = uniqueUserId('jobs')
	const first = await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-a',
			status: 'success',
			ranAt: '2026-07-31T10:00:00.000Z',
			durationMs: 120,
		},
	})
	expect(first).toMatchObject({
		jobId: 'job-a',
		lastRunAt: '2026-07-31T10:00:00.000Z',
		lastRunStatus: 'success',
		lastRunError: null,
		lastDurationMs: 120,
		runCount: 1,
		successCount: 1,
		errorCount: 0,
	})

	const second = await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-a',
			status: 'error',
			ranAt: '2026-07-31T11:00:00.000Z',
			error: 'boom',
			durationMs: 40,
		},
	})
	expect(second).toMatchObject({
		jobId: 'job-a',
		lastRunAt: '2026-07-31T11:00:00.000Z',
		lastRunStatus: 'error',
		lastRunError: 'boom',
		lastDurationMs: 40,
		runCount: 2,
		successCount: 1,
		errorCount: 1,
	})

	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-b',
			status: 'success',
			ranAt: '2026-07-31T12:00:00.000Z',
			durationMs: 10,
		},
	})

	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-a' }),
	).toMatchObject({ runCount: 2, errorCount: 1 })
	const batch = await getJobRunObservabilityBatch({
		env,
		userId,
		jobIds: ['job-b', 'job-a', 'missing'],
	})
	expect(batch.map((row) => row.jobId)).toEqual(['job-a', 'job-b'])
})

test('finishRun updates job observability for success/error and ignores replay', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('jobs-finish')

	const successHandle = beginRunRecord({
		env,
		userId,
		context: {
			surface: 'job',
			name: 'daily',
			jobId: 'job-finish',
			packageId: 'pkg-job',
		},
	})
	expect(successHandle).not.toBeNull()
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
		logs: ['ok'],
	})
	const afterSuccess = await getJobRunObservability({
		env,
		userId,
		jobId: 'job-finish',
	})
	expect(afterSuccess).toMatchObject({
		jobId: 'job-finish',
		lastRunStatus: 'success',
		lastRunError: null,
		runCount: 1,
		successCount: 1,
		errorCount: 0,
	})
	expect(afterSuccess?.lastDurationMs).toBeGreaterThanOrEqual(0)
	expect(afterSuccess?.lastRunAt).toEqual(expect.any(String))

	// Replayed terminal finish of the same run must not double-count.
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
		logs: ['replay'],
	})
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-finish' }),
	).toMatchObject({
		runCount: 1,
		successCount: 1,
		errorCount: 0,
		lastRunStatus: 'success',
	})

	const errorHandle = beginRunRecord({
		env,
		userId,
		context: {
			surface: 'job',
			name: 'daily',
			jobId: 'job-finish',
			packageId: 'pkg-job',
		},
	})
	await finishRunRecord({
		env,
		handle: errorHandle,
		status: 'error',
		error: new Error('job blew up'),
	})
	const afterError = await getJobRunObservability({
		env,
		userId,
		jobId: 'job-finish',
	})
	expect(afterError).toMatchObject({
		jobId: 'job-finish',
		lastRunStatus: 'error',
		lastRunError: 'job blew up',
		runCount: 2,
		successCount: 1,
		errorCount: 1,
	})

	await finishRunRecord({
		env,
		handle: errorHandle,
		status: 'error',
		error: new Error('job blew up again'),
	})
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-finish' }),
	).toMatchObject({
		runCount: 2,
		successCount: 1,
		errorCount: 1,
		// Replay keeps the first terminal error message.
		lastRunError: 'job blew up',
	})

	// Without jobId, finish must not invent observability rows.
	await finishRunRecord({
		env,
		handle: beginRunRecord({
			env,
			userId,
			context: { surface: 'job', name: 'no-job-id', packageId: 'pkg-job' },
		}),
		status: 'success',
	})
	expect(
		await getJobRunObservabilityBatch({
			env,
			userId,
			jobIds: ['job-finish'],
		}),
	).toHaveLength(1)
})

test('activation counts same-package successes, excludes HTTP surfaces, and is idempotent on replay', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('activation')

	async function finishSuccess(input: {
		packageId: string
		surface: RunRecordContext['surface']
	}) {
		const handle = beginRunRecord({
			env,
			userId,
			context: {
				surface: input.surface,
				name: `${input.surface}-${input.packageId}`,
				packageId: input.packageId,
			},
		})
		expect(handle).not.toBeNull()
		await finishRunRecord({
			env,
			handle,
			status: 'success',
			logs: ['ok'],
		})
		return handle!
	}

	const first = await finishSuccess({ packageId: 'pkg-a', surface: 'job' })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-a', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({
			milestone: 'package_run_succeeded',
			packageId: 'pkg-a',
		}),
	])

	// Replay/replacement of the same terminal success must not re-count.
	await finishRunRecord({
		env,
		handle: first,
		status: 'success',
		logs: ['replay'],
	})
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-a', successCount: 1 }),
	])

	await finishSuccess({ packageId: 'pkg-b', surface: 'service' })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-a', successCount: 1 }),
		expect.objectContaining({ packageId: 'pkg-b', successCount: 1 }),
	])
	expect(
		(await listActivationMilestones({ env, userId })).map(
			(row) => row.milestone,
		),
	).toEqual(['package_run_succeeded'])

	await finishSuccess({ packageId: 'pkg-a', surface: 'webhook' })
	await finishSuccess({ packageId: 'pkg-a', surface: 'app_fetch' })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-a', successCount: 1 }),
		expect.objectContaining({ packageId: 'pkg-b', successCount: 1 }),
	])

	await finishSuccess({ packageId: 'pkg-a', surface: 'workflow' })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-a', successCount: 2 }),
		expect.objectContaining({ packageId: 'pkg-b', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({
			milestone: 'package_activated',
			packageId: 'pkg-a',
		}),
		expect.objectContaining({
			milestone: 'package_run_succeeded',
			packageId: 'pkg-a',
		}),
	])

	// Global package_activated latch: further successes must not change counters.
	await finishSuccess({ packageId: 'pkg-a', surface: 'job' })
	await finishSuccess({ packageId: 'pkg-b', surface: 'job' })
	await finishSuccess({ packageId: 'pkg-c', surface: 'workflow' })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-a', successCount: 2 }),
		expect.objectContaining({ packageId: 'pkg-b', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({
			milestone: 'package_activated',
			packageId: 'pkg-a',
		}),
		expect.objectContaining({
			milestone: 'package_run_succeeded',
			packageId: 'pkg-a',
		}),
	])

	// Keyed package invocation finish also activates once, and fencing stays intact.
	const claimUser = uniqueUserId('activation-invoke')
	const claimInput = {
		id: crypto.randomUUID(),
		tokenId: 'token-1',
		packageId: 'pkg-invoke',
		packageKodyId: 'kody-invoke',
		exportName: 'handler',
		idempotencyKey: 'evt-1',
		requestHash: 'hash-1',
		source: null,
		topic: null,
	}
	const claimed = await claimPackageInvocationRecord({
		env,
		userId: claimUser,
		context: {
			surface: 'export',
			packageId: 'pkg-invoke',
			name: 'handler',
			idempotencyKey: 'evt-1',
		},
		invocation: claimInput,
		staleBefore: new Date(0).toISOString(),
	})
	expect(claimed.outcome).toBe('claimed')
	if (claimed.outcome !== 'claimed') throw new Error('expected claim')
	const finished = await finishPackageInvocationRecord({
		env,
		userId: claimUser,
		handle: claimed.handle,
		invocationId: claimed.invocationId,
		claimUpdatedAt: claimed.claimUpdatedAt,
		ledgerStatus: 'completed',
		responseJson: JSON.stringify({ ok: true }),
		status: 'success',
	})
	expect(finished.ledgerUpdated).toBe(true)
	expect(await listPackageRunSuccesses({ env, userId: claimUser })).toEqual([
		expect.objectContaining({ packageId: 'pkg-invoke', successCount: 1 }),
	])
	await finishPackageInvocationRecord({
		env,
		userId: claimUser,
		handle: claimed.handle,
		invocationId: claimed.invocationId,
		claimUpdatedAt: claimed.claimUpdatedAt,
		ledgerStatus: 'completed',
		responseJson: JSON.stringify({ ok: true }),
		status: 'success',
	})
	expect(await listPackageRunSuccesses({ env, userId: claimUser })).toEqual([
		expect.objectContaining({ packageId: 'pkg-invoke', successCount: 1 }),
	])
})

test('retention prunes runs but never dedicated workflow/job/activation state', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('retention')

	// Recent terminal projection (within the 90-day workflow lane) plus job /
	// activation counters: run age/excess prune must not remove them.
	const recentWorkflowAt = new Date(
		Date.now() - 2 * 24 * 60 * 60 * 1000,
	).toISOString()
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-keep',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'keep',
			idempotencyKey: 'idem-keep',
			runAt: recentWorkflowAt,
			status: 'complete',
			createdAt: recentWorkflowAt,
			updatedAt: recentWorkflowAt,
			completedAt: recentWorkflowAt,
		},
	})
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-keep',
			status: 'success',
			ranAt: recentWorkflowAt,
			durationMs: 5,
		},
	})

	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const agedStartedAt = new Date(
		Date.now() - 40 * 24 * 60 * 60 * 1000,
	).toISOString()
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		for (let i = 0; i < 5; i += 1) {
			insertAgedRun(state, { id: `aged-${i}`, startedAt: agedStartedAt })
		}
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES ('run_count', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			5,
		)
	})
	await armRetentionOnNextFinish(userId, 5)

	const handle = beginRunRecord({
		env,
		userId,
		context: {
			surface: 'job',
			name: 'trigger-retention',
			packageId: 'pkg-keep',
		},
	})
	await finishRunRecord({ env, handle, status: 'success' })

	const remainingRuns = await listRunRecords({ env, userId, limit: 100 })
	expect(remainingRuns.runs.every((run) => !run.id.startsWith('aged-'))).toBe(
		true,
	)

	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-keep' }),
	).toMatchObject({ id: 'wf-keep', bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS' })
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-keep' }),
	).toMatchObject({ jobId: 'job-keep', successCount: 1 })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-keep', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({ milestone: 'package_run_succeeded' }),
	])

	// Excess-count prune also leaves dedicated state alone.
	await runInDurableObject(stub, async (_instance: RunLog, state) => {
		const now = new Date().toISOString()
		for (let i = 0; i < runRecordMaxRunsPerUser + 10; i += 1) {
			insertAgedRun(state, {
				id: `excess-${String(i).padStart(4, '0')}`,
				startedAt: now,
			})
		}
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES ('run_count', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			runRecordMaxRunsPerUser + 10,
		)
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES ('finishes_since_retention', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			runRecordRetentionEveryNFinishes - 1,
		)
	})
	const excessHandle = beginRunRecord({
		env,
		userId,
		context: { surface: 'job', name: 'excess-trigger', packageId: 'pkg-keep' },
	})
	await finishRunRecord({ env, handle: excessHandle, status: 'error' })

	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-keep' }),
	).not.toBeNull()
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-keep' }),
	).not.toBeNull()
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-keep' }),
	])
})

test('export pages dedicated state after runs and ledger; clearAll purges and reinitializes it', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('export')

	const handle = beginRunRecord({
		env,
		userId,
		context: {
			surface: 'job',
			name: 'export-run',
			packageId: 'pkg-export',
		},
	})
	await finishRunRecord({ env, handle, status: 'success' })
	await finishRunRecord({
		env,
		handle: beginRunRecord({
			env,
			userId,
			context: {
				surface: 'job',
				name: 'export-run-2',
				packageId: 'pkg-export',
			},
		}),
		status: 'success',
	})

	const claimed = await claimPackageInvocationRecord({
		env,
		userId,
		context: {
			surface: 'export',
			packageId: 'pkg-export',
			name: 'handler',
			idempotencyKey: 'export-evt',
		},
		invocation: {
			id: crypto.randomUUID(),
			tokenId: 'token-export',
			packageId: 'pkg-export',
			packageKodyId: 'kody-export',
			exportName: 'handler',
			idempotencyKey: 'export-evt',
			requestHash: 'hash-export',
			source: null,
			topic: null,
		},
		staleBefore: new Date(0).toISOString(),
	})
	if (claimed.outcome !== 'claimed') throw new Error('expected claim')
	await finishPackageInvocationRecord({
		env,
		userId,
		handle: claimed.handle,
		invocationId: claimed.invocationId,
		claimUpdatedAt: claimed.claimUpdatedAt,
		ledgerStatus: 'completed',
		responseJson: JSON.stringify({ ok: true }),
		status: 'success',
	})

	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-export',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'export-wf',
			idempotencyKey: 'idem-export',
			runAt: '2026-07-31T00:00:00.000Z',
			status: 'complete',
		},
	})
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-export',
			status: 'success',
			ranAt: '2026-07-31T00:00:00.000Z',
			durationMs: 3,
		},
	})

	const seen = {
		runs: new Set<string>(),
		ledger: new Set<string>(),
		workflows: new Set<string>(),
		jobs: new Set<string>(),
		successes: new Set<string>(),
		milestones: new Set<string>(),
	}
	let startAfter: string | null = null
	for (let page = 0; page < 20; page += 1) {
		const exported = await exportRunRecords({
			env,
			userId,
			pageSize: 2,
			startAfter,
		})
		for (const run of exported.runs) seen.runs.add(run.id)
		for (const row of exported.packageInvocations) seen.ledger.add(row.id)
		for (const row of exported.workflowProjections) seen.workflows.add(row.id)
		for (const row of exported.jobRunObservability) seen.jobs.add(row.jobId)
		for (const row of exported.packageRunSuccesses) {
			seen.successes.add(row.packageId)
		}
		for (const row of exported.activationMilestones) {
			seen.milestones.add(row.milestone)
		}
		if (!exported.truncated) break
		startAfter = exported.nextStartAfter
	}

	expect(seen.runs.size).toBeGreaterThanOrEqual(3)
	expect(seen.ledger.size).toBe(1)
	expect(seen.workflows.has('wf-export')).toBe(true)
	expect(seen.jobs.has('job-export')).toBe(true)
	expect(seen.successes.has('pkg-export')).toBe(true)
	expect(seen.milestones.has('package_run_succeeded')).toBe(true)
	expect(seen.milestones.has('package_activated')).toBe(true)

	// Old raw run-id cursor remains valid (resumes runs phase).
	const firstRunId = [...seen.runs].sort()[0]!
	const fromRunCursor = await exportRunRecords({
		env,
		userId,
		pageSize: 50,
		startAfter: firstRunId,
	})
	expect(fromRunCursor.runs.every((run) => run.id > firstRunId)).toBe(true)

	await clearRunRecords({ env, userId })
	const afterClear = await exportRunRecords({ env, userId, pageSize: 50 })
	expect(afterClear).toMatchObject({
		runs: [],
		packageInvocations: [],
		workflowProjections: [],
		jobRunObservability: [],
		packageRunSuccesses: [],
		activationMilestones: [],
		truncated: false,
		nextStartAfter: null,
	})
	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-export' }),
	).toBeNull()
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-export' }),
	).toBeNull()
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([])
	expect(await listActivationMilestones({ env, userId })).toEqual([])
	expect(await countActiveWorkflowProjections({ env, userId })).toBe(0)

	// Reinitialized schema accepts new dedicated writes after clearAll.
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-after-clear',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'fresh',
			idempotencyKey: 'idem-fresh',
			runAt: '2026-07-31T03:00:00.000Z',
			status: 'queued',
		},
	})
	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-after-clear' }),
	).toMatchObject({ id: 'wf-after-clear', status: 'queued' })
})

test('export cursors always make progress across phase handoffs and empty tails', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('export-progress')

	// Exactly pageSize runs so the first page hands off with remaining=0.
	for (let i = 0; i < 2; i += 1) {
		await finishRunRecord({
			env,
			handle: beginRunRecord({
				env,
				userId,
				context: {
					surface: 'job',
					name: `run-${i}`,
					jobId: `job-progress-${i}`,
					packageId: 'pkg-progress',
				},
			}),
			status: 'success',
		})
	}
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-progress',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'progress',
			idempotencyKey: 'idem-progress',
			runAt: '2026-07-31T00:00:00.000Z',
			status: 'complete',
		},
	})

	const cursors: Array<string | null> = []
	let startAfter: string | null = null
	let sawWorkflow = false
	let sawJob = false
	for (let page = 0; page < 12; page += 1) {
		const exported = await exportRunRecords({
			env,
			userId,
			pageSize: 2,
			startAfter,
		})
		cursors.push(exported.nextStartAfter)
		if (exported.workflowProjections.length > 0) sawWorkflow = true
		if (exported.jobRunObservability.length > 0) sawJob = true
		// Truncated pages must advance the cursor; repeating one spins clients.
		if (exported.truncated) {
			expect(exported.nextStartAfter).not.toBeNull()
			expect(exported.nextStartAfter).not.toBe(startAfter)
			startAfter = exported.nextStartAfter
			continue
		}
		expect(exported.nextStartAfter).toBeNull()
		break
	}
	expect(sawWorkflow).toBe(true)
	expect(sawJob).toBe(true)
	expect(new Set(cursors.filter((cursor) => cursor != null)).size).toBe(
		cursors.filter((cursor) => cursor != null).length,
	)

	// Prefixed cursors past all remaining rows must terminate (not re-emit).
	const emptyUser = uniqueUserId('export-empty-tail')
	for (const emptyTail of [
		'invocation-ledger:',
		'workflow-projections:',
		'job-run-observability:',
		'package-run-successes:',
		'activation-milestones:',
		'activation-milestones:zzz',
	]) {
		const page = await exportRunRecords({
			env,
			userId: emptyUser,
			pageSize: 2,
			startAfter: emptyTail,
		})
		expect(page).toMatchObject({
			truncated: false,
			nextStartAfter: null,
			runs: [],
			packageInvocations: [],
			workflowProjections: [],
			jobRunObservability: [],
			packageRunSuccesses: [],
			activationMilestones: [],
		})
	}
})

function jobRunObservabilityColumnNames(state: DurableObjectState) {
	return state.storage.sql
		.exec<{ name: string }>(`PRAGMA table_info(job_run_observability)`)
		.toArray()
		.map((row) => String(row.name))
}

test('fresh schema v8 creates job_run_observability with inert legacy_seeded for rollback', async () => {
	const userId = uniqueUserId('schema-v8-fresh')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		const version = state.storage.sql
			.exec<{ value: number }>(
				`SELECT value FROM run_log_meta WHERE key = 'schema_version' LIMIT 1`,
			)
			.toArray()[0]
		expect(Number(version?.value)).toBe(8)

		expect(jobRunObservabilityColumnNames(state)).toEqual([
			'job_id',
			'last_run_at',
			'last_run_status',
			'last_run_error',
			'last_duration_ms',
			'run_count',
			'success_count',
			'error_count',
			'updated_at',
			'legacy_seeded',
		])

		// Simulated v7-style INSERT including legacy_seeded must succeed on
		// fresh v8 storage so a rollback deploy can still write the column.
		state.storage.sql.exec(
			`INSERT INTO job_run_observability (
				job_id, last_run_at, last_run_status, last_run_error, last_duration_ms,
				run_count, success_count, error_count, updated_at, legacy_seeded
			) VALUES ('job-v7-insert', '2026-08-01T00:00:00.000Z', 'success', NULL, 10,
				3, 2, 1, '2026-08-01T00:00:00.000Z', 1)`,
		)
		const seeded = state.storage.sql
			.exec<{ legacy_seeded: number }>(
				`SELECT legacy_seeded FROM job_run_observability
				WHERE job_id = 'job-v7-insert' LIMIT 1`,
			)
			.toArray()[0]
		expect(Number(seeded?.legacy_seeded)).toBe(1)
	})

	const updated = await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-v7-insert',
			status: 'error',
			ranAt: '2026-08-01T01:00:00.000Z',
			error: 'post-v8',
		},
	})
	expect(updated).toMatchObject({
		jobId: 'job-v7-insert',
		runCount: 4,
		successCount: 2,
		errorCount: 2,
		lastRunStatus: 'error',
		lastRunError: 'post-v8',
	})
	expect(updated).not.toHaveProperty('legacySeeded')
})

test('warm schema v7 job_run_observability upgrades to v8 without ALTER', async () => {
	const userId = uniqueUserId('schema-v7-warm')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		await state.storage.deleteAll()

		state.storage.sql.exec(`
			CREATE TABLE run_log_meta (
				key TEXT PRIMARY KEY NOT NULL,
				value INTEGER NOT NULL
			)
		`)
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES ('schema_version', 7)`,
		)
		state.storage.sql.exec(`
			CREATE TABLE job_run_observability (
				job_id TEXT PRIMARY KEY NOT NULL,
				last_run_at TEXT,
				last_run_status TEXT,
				last_run_error TEXT,
				last_duration_ms INTEGER,
				run_count INTEGER NOT NULL DEFAULT 0,
				success_count INTEGER NOT NULL DEFAULT 0,
				error_count INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL,
				legacy_seeded INTEGER NOT NULL DEFAULT 0
			)
		`)
		state.storage.sql.exec(
			`INSERT INTO job_run_observability (
				job_id, last_run_at, last_run_status, last_run_error, last_duration_ms,
				run_count, success_count, error_count, updated_at, legacy_seeded
			) VALUES ('job-warm-v7', '2026-07-01T00:00:00.000Z', 'success', NULL, 5,
				1, 1, 0, '2026-07-01T00:00:00.000Z', 1)`,
		)

		const alterStatements: Array<string> = []
		const originalExec = state.storage.sql.exec.bind(state.storage.sql)
		state.storage.sql.exec = (query: string, ...args: Array<unknown>) => {
			if (/ALTER\s+TABLE/i.test(query)) {
				alterStatements.push(query)
			}
			return originalExec(query, ...args)
		}

		const proto = Object.getPrototypeOf(instance) as {
			initializeSchema: () => void
		}
		proto.initializeSchema.call(instance)

		expect(alterStatements).toEqual([])
		const version = state.storage.sql
			.exec<{ value: number }>(
				`SELECT value FROM run_log_meta WHERE key = 'schema_version' LIMIT 1`,
			)
			.toArray()[0]
		expect(Number(version?.value)).toBe(8)
		expect(jobRunObservabilityColumnNames(state)).toContain('legacy_seeded')

		const preserved = state.storage.sql
			.exec<{ legacy_seeded: number; run_count: number }>(
				`SELECT legacy_seeded, run_count FROM job_run_observability
				WHERE job_id = 'job-warm-v7' LIMIT 1`,
			)
			.toArray()[0]
		expect(Number(preserved?.legacy_seeded)).toBe(1)
		expect(Number(preserved?.run_count)).toBe(1)
	})

	const read = await getJobRunObservability({
		env,
		userId,
		jobId: 'job-warm-v7',
	})
	expect(read).toMatchObject({
		jobId: 'job-warm-v7',
		runCount: 1,
		successCount: 1,
		lastRunStatus: 'success',
	})
	expect(read).not.toHaveProperty('legacySeeded')
})

test('getAdminInsightsSnapshot returns content-free workflow counts and milestones', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('admin-insights')
	const reachedAt = '2026-08-01T12:00:00.000Z'

	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-running-1',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'secret-name-must-not-leak',
			idempotencyKey: 'admin-running-1',
			runAt: reachedAt,
			status: 'running',
			createdAt: reachedAt,
			updatedAt: reachedAt,
			lastError: 'secret-error-must-not-leak',
		},
	})
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-running-2',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'other',
			idempotencyKey: 'admin-running-2',
			runAt: reachedAt,
			status: 'running',
			createdAt: reachedAt,
			updatedAt: reachedAt,
		},
	})
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-complete',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'done',
			idempotencyKey: 'admin-complete',
			runAt: reachedAt,
			status: 'complete',
			createdAt: reachedAt,
			updatedAt: reachedAt,
			completedAt: reachedAt,
		},
	})

	await finishRunRecord({
		env,
		handle: beginRunRecord({
			env,
			userId,
			context: {
				surface: 'job',
				name: 'activate',
				packageId: 'pkg-admin',
				jobId: 'job-admin',
			},
		}),
		status: 'success',
	})
	await finishRunRecord({
		env,
		handle: beginRunRecord({
			env,
			userId,
			context: {
				surface: 'job',
				name: 'activate-2',
				packageId: 'pkg-admin',
			},
		}),
		status: 'success',
	})

	const snapshot = await getAdminInsightsSnapshot({ env, userId })
	expect(snapshot.workflowStatusCounts).toEqual([
		{ status: 'running', count: 2 },
		{ status: 'complete', count: 1 },
	])
	expect(snapshot.activationMilestones).toEqual([
		expect.objectContaining({
			milestone: 'package_activated',
			packageId: 'pkg-admin',
			reachedAt: expect.any(String),
		}),
		expect.objectContaining({
			milestone: 'package_run_succeeded',
			packageId: 'pkg-admin',
			reachedAt: expect.any(String),
		}),
	])

	const serialized = JSON.stringify(snapshot)
	expect(serialized).not.toMatch(/secret-name-must-not-leak/)
	expect(serialized).not.toMatch(/secret-error-must-not-leak/)
	expect(serialized).not.toMatch(/job-admin/)
	expect(serialized).not.toMatch(/"name"/)
	expect(serialized).not.toMatch(/lastError|errorMessage|workflowName|"logs"/)

	for (const key of Object.keys(snapshot)) {
		expect(['workflowStatusCounts', 'activationMilestones']).toContain(key)
	}
	for (const row of snapshot.workflowStatusCounts) {
		expect(Object.keys(row).sort()).toEqual(['count', 'status'])
	}
	for (const row of snapshot.activationMilestones) {
		expect(Object.keys(row).sort()).toEqual([
			'milestone',
			'packageId',
			'reachedAt',
		])
	}
})
