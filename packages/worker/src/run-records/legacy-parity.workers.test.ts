import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	jobRunObservabilitySeedMaxBatch,
	legacyParityVerifyMaxBatch,
	importActivationState,
	importWorkflowProjections,
	seedJobRunObservabilityBatch,
	upsertJobRunObservability,
	upsertWorkflowProjection,
	verifyLegacyParity,
} from './service.ts'

function uniqueUserId(label: string) {
	return `runlog-legacy-parity-${label}-${crypto.randomUUID()}`
}

function jobSeed(input: {
	jobId: string
	runCount?: number
	successCount?: number
	errorCount?: number
	lastRunError?: string | null
	updatedAt?: string
}) {
	return {
		jobId: input.jobId,
		lastRunAt: input.updatedAt ?? '2026-07-01T00:00:00.000Z',
		lastRunStatus: 'success' as const,
		lastRunError: input.lastRunError ?? null,
		lastDurationMs: 12,
		runCount: input.runCount ?? 3,
		successCount: input.successCount ?? 2,
		errorCount: input.errorCount ?? 1,
		updatedAt: input.updatedAt ?? '2026-07-01T00:00:00.000Z',
	}
}

test(
	'legacy seed batch and parity cover complete, missing, under-count, bounds, isolation, and content deny-list',
	{ timeout: 20_000 },
	async () => {
		const userId = uniqueUserId('sweep')
		const otherUserId = uniqueUserId('other')
		const secretWorkflowName = `secret-workflow-${crypto.randomUUID()}`
		const secretJobError = `secret-job-error-${crypto.randomUUID()}`
		const secretPackageId = `secret-pkg-${crypto.randomUUID()}`
		const workflowFreshId = `wf-fresh-${crypto.randomUUID()}`
		const workflowStaleId = `wf-stale-${crypto.randomUUID()}`
		const workflowMissingId = `wf-missing-${crypto.randomUUID()}`
		const jobSeededId = `job-seeded-${crypto.randomUUID()}`
		const jobUnseededId = `job-unseeded-${crypto.randomUUID()}`
		const jobMissingId = `job-missing-${crypto.randomUUID()}`
		const jobIdempotentId = `job-idempotent-${crypto.randomUUID()}`

		await importWorkflowProjections({
			env,
			userId,
			projections: [
				{
					id: workflowFreshId,
					bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
					sourceType: 'inline',
					workflowName: secretWorkflowName,
					idempotencyKey: 'fresh-key',
					runAt: '2026-07-31T20:00:00.000Z',
					status: 'complete',
					createdAt: '2026-07-31T20:00:00.000Z',
					updatedAt: '2026-07-31T20:00:05.000Z',
					completedAt: '2026-07-31T20:00:05.000Z',
					lastError: null,
				},
				{
					id: workflowStaleId,
					bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
					sourceType: 'inline',
					workflowName: secretWorkflowName,
					idempotencyKey: 'stale-key',
					runAt: '2026-07-31T19:00:00.000Z',
					status: 'complete',
					createdAt: '2026-07-31T19:00:00.000Z',
					updatedAt: '2026-07-31T19:00:00.000Z',
					completedAt: '2026-07-31T19:00:00.000Z',
					lastError: null,
				},
			],
		})

		const firstSeed = await seedJobRunObservabilityBatch({
			env,
			userId,
			seeds: [
				jobSeed({
					jobId: jobSeededId,
					lastRunError: secretJobError,
					runCount: 5,
					successCount: 4,
					errorCount: 1,
				}),
				jobSeed({ jobId: jobIdempotentId, runCount: 2, successCount: 2 }),
			],
		})
		expect(firstSeed).toEqual({
			attempted: 2,
			seeded: 2,
			alreadySeeded: 0,
		})

		// Post-cutover finish creates a row before legacy seed marks it.
		await upsertJobRunObservability({
			env,
			userId,
			outcome: {
				jobId: jobUnseededId,
				status: 'error',
				ranAt: '2026-08-01T00:00:00.000Z',
				error: secretJobError,
				durationMs: 9,
			},
		})

		const idempotentReseed = await seedJobRunObservabilityBatch({
			env,
			userId,
			seeds: [
				jobSeed({
					jobId: jobIdempotentId,
					runCount: 99,
					successCount: 99,
					lastRunError: 'must-not-apply-twice',
				}),
				jobSeed({ jobId: jobSeededId, runCount: 1 }),
			],
		})
		expect(idempotentReseed).toEqual({
			attempted: 2,
			seeded: 0,
			alreadySeeded: 2,
		})

		await importActivationState({
			env,
			userId,
			state: {
				packageRunSuccesses: [
					{
						packageId: secretPackageId,
						// Keep below the activated threshold so import does not
						// derive `package_activated` (needed for the missing case).
						successCount: 1,
						updatedAt: '2026-07-01T00:00:00.000Z',
					},
					{
						packageId: 'pkg-under',
						successCount: 1,
						updatedAt: '2026-07-01T00:00:00.000Z',
					},
				],
				milestones: [
					{
						milestone: 'package_run_succeeded',
						reachedAt: '2026-07-01T00:00:00.000Z',
						packageId: secretPackageId,
					},
				],
			},
		})

		const completeParity = await verifyLegacyParity({
			env,
			userId,
			workflows: [
				workflowFreshId,
				{ id: workflowFreshId, minimumUpdatedAt: '2026-07-31T20:00:00.000Z' },
			],
			jobIds: [jobSeededId, jobIdempotentId],
			activationPackages: [
				{ packageId: secretPackageId, minimumSuccessCount: 1 },
			],
			activationMilestones: ['package_run_succeeded'],
		})
		expect(completeParity).toEqual({
			workflows: { matched: 2, missing: 0, underCount: 0 },
			jobs: { matched: 2, missing: 0, underCount: 0 },
			activationPackages: { matched: 1, missing: 0, underCount: 0 },
			activationMilestones: { matched: 1, missing: 0, underCount: 0 },
			activationInitialized: true,
			parity: true,
		})

		const incompleteParity = await verifyLegacyParity({
			env,
			userId,
			workflows: [
				workflowMissingId,
				{ id: workflowStaleId, minimumUpdatedAt: '2026-07-31T20:00:00.000Z' },
			],
			jobIds: [jobMissingId, jobUnseededId],
			activationPackages: [
				{ packageId: 'pkg-missing', minimumSuccessCount: 1 },
				{ packageId: 'pkg-under', minimumSuccessCount: 2 },
			],
			activationMilestones: ['package_activated'],
		})
		expect(incompleteParity).toEqual({
			workflows: { matched: 0, missing: 1, underCount: 1 },
			jobs: { matched: 0, missing: 1, underCount: 1 },
			activationPackages: { matched: 0, missing: 1, underCount: 1 },
			activationMilestones: { matched: 0, missing: 1, underCount: 0 },
			activationInitialized: true,
			parity: false,
		})

		const otherParity = await verifyLegacyParity({
			env,
			userId: otherUserId,
			workflows: [workflowFreshId],
			jobIds: [jobSeededId],
			activationPackages: [
				{ packageId: secretPackageId, minimumSuccessCount: 1 },
			],
			activationMilestones: ['package_run_succeeded'],
		})
		expect(otherParity).toEqual({
			workflows: { matched: 0, missing: 1, underCount: 0 },
			jobs: { matched: 0, missing: 1, underCount: 0 },
			activationPackages: { matched: 0, missing: 1, underCount: 0 },
			activationMilestones: { matched: 0, missing: 1, underCount: 0 },
			activationInitialized: false,
			parity: false,
		})

		const oversizedSeeds = Array.from(
			{ length: jobRunObservabilitySeedMaxBatch + 1 },
			(_, index) => jobSeed({ jobId: `job-over-${index}` }),
		)
		await expect(
			seedJobRunObservabilityBatch({
				env,
				userId,
				seeds: oversizedSeeds,
			}),
		).rejects.toThrow(new RegExp(`at most ${jobRunObservabilitySeedMaxBatch}`))

		const oversizedJobIds = Array.from(
			{ length: legacyParityVerifyMaxBatch + 1 },
			(_, index) => `job-bound-${index}`,
		)
		await expect(
			verifyLegacyParity({
				env,
				userId,
				jobIds: oversizedJobIds,
			}),
		).rejects.toThrow(new RegExp(`at most ${legacyParityVerifyMaxBatch}`))

		const denyListTargets = [
			secretWorkflowName,
			secretJobError,
			'must-not-apply-twice',
			'lastRunError',
			'workflowName',
			'errorMessage',
			'errorName',
		]
		const serialized = JSON.stringify({ completeParity, incompleteParity })
		for (const denied of denyListTargets) {
			expect(serialized).not.toContain(denied)
		}
		// Count-only shape: no nested content fields beyond the documented keys.
		for (const report of [completeParity, incompleteParity, otherParity]) {
			expect(Object.keys(report).sort()).toEqual([
				'activationInitialized',
				'activationMilestones',
				'activationPackages',
				'jobs',
				'parity',
				'workflows',
			])
			for (const bucket of [
				report.workflows,
				report.jobs,
				report.activationPackages,
				report.activationMilestones,
			]) {
				expect(Object.keys(bucket).sort()).toEqual([
					'matched',
					'missing',
					'underCount',
				])
			}
		}
	},
)

test('importActivationState empty marks activation unconditional-done for parity', async () => {
	const userId = uniqueUserId('activation-empty')
	const before = await verifyLegacyParity({ env, userId })
	expect(before).toMatchObject({
		activationInitialized: false,
		parity: true,
	})

	const imported = await importActivationState({
		env,
		userId,
		state: { packageRunSuccesses: [], milestones: [] },
	})
	expect(imported).toEqual({ initialized: true })

	const after = await verifyLegacyParity({
		env,
		userId,
		activationMilestones: [],
		activationPackages: [],
	})
	expect(after).toEqual({
		workflows: { matched: 0, missing: 0, underCount: 0 },
		jobs: { matched: 0, missing: 0, underCount: 0 },
		activationPackages: { matched: 0, missing: 0, underCount: 0 },
		activationMilestones: { matched: 0, missing: 0, underCount: 0 },
		activationInitialized: true,
		parity: true,
	})

	// Empty import is idempotent and does not invent milestone rows.
	await importActivationState({
		env,
		userId,
		state: { packageRunSuccesses: [], milestones: [] },
	})
	const stillEmpty = await verifyLegacyParity({
		env,
		userId,
		activationMilestones: ['package_run_succeeded'],
	})
	expect(stillEmpty).toMatchObject({
		activationInitialized: true,
		activationMilestones: { matched: 0, missing: 1, underCount: 0 },
		parity: false,
	})
})

test('seedJobRunObservabilityBatch merges once onto post-cutover counters', async () => {
	const userId = uniqueUserId('merge-once')
	const jobId = `job-merge-${crypto.randomUUID()}`
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId,
			status: 'success',
			ranAt: '2026-08-02T00:00:00.000Z',
			durationMs: 4,
		},
	})

	const seeded = await seedJobRunObservabilityBatch({
		env,
		userId,
		seeds: [
			jobSeed({
				jobId,
				runCount: 5,
				successCount: 4,
				errorCount: 1,
				updatedAt: '2026-07-01T00:00:00.000Z',
			}),
		],
	})
	expect(seeded).toEqual({ attempted: 1, seeded: 1, alreadySeeded: 0 })

	const parity = await verifyLegacyParity({
		env,
		userId,
		jobIds: [jobId],
	})
	expect(parity.jobs).toEqual({ matched: 1, missing: 0, underCount: 0 })
	expect(parity.parity).toBe(true)

	const again = await seedJobRunObservabilityBatch({
		env,
		userId,
		seeds: [jobSeed({ jobId, runCount: 100, successCount: 100 })],
	})
	expect(again).toEqual({ attempted: 1, seeded: 0, alreadySeeded: 1 })
})

test('seedJobRunObservabilityBatch attempted includes blanks; already-seeded is classified once', async () => {
	const userId = uniqueUserId('attempted-semantics')
	const jobId = `job-attempted-${crypto.randomUUID()}`

	const withBlank = await seedJobRunObservabilityBatch({
		env,
		userId,
		seeds: [
			jobSeed({ jobId }),
			jobSeed({ jobId: '   ' }),
			jobSeed({ jobId: '' }),
		],
	})
	// attempted is input length; blanks are neither seeded nor alreadySeeded.
	expect(withBlank).toEqual({
		attempted: 3,
		seeded: 1,
		alreadySeeded: 0,
	})
	expect(withBlank.attempted).toBeGreaterThan(
		withBlank.seeded + withBlank.alreadySeeded,
	)

	const reseed = await seedJobRunObservabilityBatch({
		env,
		userId,
		seeds: [jobSeed({ jobId, runCount: 50 }), jobSeed({ jobId: '' })],
	})
	expect(reseed).toEqual({
		attempted: 2,
		seeded: 0,
		alreadySeeded: 1,
	})
})

test('verifyLegacyParity fails closed on malformed activation package minimums', async () => {
	const userId = uniqueUserId('malformed-min')
	const packageId = `pkg-malformed-${crypto.randomUUID()}`
	await importActivationState({
		env,
		userId,
		state: {
			packageRunSuccesses: [
				{
					packageId,
					successCount: 3,
					updatedAt: '2026-07-01T00:00:00.000Z',
				},
			],
			milestones: [],
		},
	})

	const report = await verifyLegacyParity({
		env,
		userId,
		activationPackages: [
			{ packageId, minimumSuccessCount: 2 },
			{
				packageId,
				minimumSuccessCount: Number.NaN,
			},
			{
				packageId,
				minimumSuccessCount: Number.POSITIVE_INFINITY,
			},
			{
				packageId,
				// Runtime-malformed inventory payload (typed as number).
				minimumSuccessCount: undefined as unknown as number,
			},
			{
				packageId,
				minimumSuccessCount: null as unknown as number,
			},
			{
				packageId,
				minimumSuccessCount: '' as unknown as number,
			},
			{
				packageId,
				minimumSuccessCount: '   ' as unknown as number,
			},
			{
				packageId,
				minimumSuccessCount: false as unknown as number,
			},
			{
				packageId,
				minimumSuccessCount: {} as unknown as number,
			},
			{
				packageId,
				minimumSuccessCount: '2' as unknown as number,
			},
			{ packageId: '', minimumSuccessCount: 1 },
		],
	})
	expect(report.activationPackages).toEqual({
		matched: 1,
		missing: 1,
		underCount: 9,
	})
	expect(report.parity).toBe(false)
	expect(JSON.stringify(report)).not.toContain(packageId)
})

test('verifyLegacyParity fails closed on malformed workflow minimumUpdatedAt thresholds', async () => {
	const userId = uniqueUserId('wf-threshold')
	const workflowId = `wf-threshold-${crypto.randomUUID()}`
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: workflowId,
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'threshold',
			idempotencyKey: 'threshold-key',
			runAt: '2026-07-31T20:00:00.000Z',
			status: 'complete',
			createdAt: '2026-07-31T20:00:00.000Z',
			updatedAt: '2026-07-31T20:00:05.000Z',
			completedAt: '2026-07-31T20:00:05.000Z',
		},
	})

	const report = await verifyLegacyParity({
		env,
		userId,
		workflows: [
			workflowId,
			{ id: workflowId, minimumUpdatedAt: null },
			{ id: workflowId, minimumUpdatedAt: '2026-07-31T20:00:05.000Z' },
			// Non-canonical but parseable UTC form still matches after canonicalize.
			{ id: workflowId, minimumUpdatedAt: '2026-07-31T20:00:05Z' },
			{ id: workflowId, minimumUpdatedAt: '2026-07-31T20:00:06.000Z' },
			{ id: workflowId, minimumUpdatedAt: '0' },
			{ id: workflowId, minimumUpdatedAt: 'junk' },
			{ id: workflowId, minimumUpdatedAt: '2026-02-30T00:00:00.000Z' },
		],
	})
	expect(report.workflows).toEqual({
		matched: 4,
		missing: 0,
		underCount: 4,
	})
	expect(report.parity).toBe(false)
})

test('verifyLegacyParity verifies a full workflow batch and rejects one over the cap', async () => {
	const userId = uniqueUserId('wf-max-batch')
	const workflowIds = Array.from(
		{ length: legacyParityVerifyMaxBatch },
		(_, index) => `wf-max-${String(index).padStart(3, '0')}`,
	)

	await importWorkflowProjections({
		env,
		userId,
		projections: workflowIds.map((id, index) => ({
			id,
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'batch',
			idempotencyKey: `key-${index}`,
			runAt: '2026-07-31T20:00:00.000Z',
			status: 'complete',
			createdAt: '2026-07-31T20:00:00.000Z',
			updatedAt: '2026-07-31T20:00:05.000Z',
			completedAt: '2026-07-31T20:00:05.000Z',
			lastError: null,
		})),
	})

	const parity = await verifyLegacyParity({
		env,
		userId,
		workflows: workflowIds,
	})
	expect(parity.workflows).toEqual({
		matched: legacyParityVerifyMaxBatch,
		missing: 0,
		underCount: 0,
	})
	expect(parity.parity).toBe(true)

	const oversizedWorkflowIds = Array.from(
		{ length: legacyParityVerifyMaxBatch + 1 },
		(_, index) => `wf-over-${index}`,
	)
	await expect(
		verifyLegacyParity({
			env,
			userId,
			workflows: oversizedWorkflowIds,
		}),
	).rejects.toThrow(new RegExp(`at most ${legacyParityVerifyMaxBatch}`))
})

test('upsertWorkflowProjection rows remain visible to importWorkflowProjections batch seeding', async () => {
	const userId = uniqueUserId('wf-batch')
	const id = `wf-batch-${crypto.randomUUID()}`
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id,
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'package',
			packageId: 'pkg-wf',
			workflowName: 'nightly',
			idempotencyKey: 'nightly-key',
			runAt: '2026-07-31T12:00:00.000Z',
			status: 'queued',
			createdAt: '2026-07-31T12:00:00.000Z',
			updatedAt: '2026-07-31T12:00:00.000Z',
		},
	})
	await importWorkflowProjections({
		env,
		userId,
		projections: [
			{
				id,
				bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
				sourceType: 'package',
				packageId: 'pkg-wf',
				workflowName: 'nightly',
				idempotencyKey: 'nightly-key',
				runAt: '2026-07-31T12:00:00.000Z',
				status: 'running',
				createdAt: '2026-07-31T12:00:00.000Z',
				updatedAt: '2026-07-31T12:00:01.000Z',
			},
		],
	})
	const parity = await verifyLegacyParity({
		env,
		userId,
		workflows: [{ id, minimumUpdatedAt: '2026-07-31T12:00:01.000Z' }],
	})
	expect(parity.workflows).toEqual({ matched: 1, missing: 0, underCount: 0 })
	expect(parity.parity).toBe(true)
})
