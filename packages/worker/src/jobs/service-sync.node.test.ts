import { expect, test, vi, afterEach } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	isEntitlementLimitError,
	isJobIntervalFloorError,
} from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { saveValue } from '#mcp/values/service.ts'
import { syncPackageJobsForPackage, updateJob } from './service.ts'
import {
	listJobRowsByUserId,
	refreshPackageJobRowIdentity,
} from '@kody-internal/shared/jobs/repo.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { type PersistedJobCallerContext } from './types.ts'
import {
	identityMockModule,
	resetJobServiceMocks,
	mockRepoPersistence,
	createDatabase,
	createJobServiceTestEnv,
	insertPublishedEntitySource,
	insertLeftoverJob,
	syncSinglePackageJob,
} from '#worker/test-support/jobs-service.ts'

vi.mock('#worker/repo/source-service.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).sourceServiceMock(),
)
vi.mock('#worker/repo/source-sync.ts', async () =>
	(await import('#worker/test-support/jobs-service-mocks.ts')).sourceSyncMock(),
)
vi.mock('#worker/repo/artifact-repo-cleanup.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).artifactRepoCleanupMock(),
)
vi.mock('#worker/repo/repo-sessions.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).repoSessionsMock(),
)
vi.mock('#worker/repo/repo-session-do.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).repoSessionDoMock(),
)
vi.mock('./manager-client.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).managerClientMock(),
)
vi.mock('#worker/identity/background-mcp-user.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).backgroundMcpUserMock(),
)
vi.mock('#worker/storage-runner.ts', async (importOriginal) =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).storageRunnerMock((await importOriginal()) as Record<string, unknown>),
)
vi.mock('#worker/worker-bundler-modules.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).workerBundlerModulesMock(),
)

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- this legacy suite restores global spies across many integration-style tests.
afterEach(() => {
	resetJobServiceMocks()
})

test('package job sync reports scheduler changes for add, update, and remove only', async () => {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
	})
	const input = {
		env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		packageId: 'package-1',
		sourceId: 'source-1',
	}
	const createManifest = (jobs: Record<string, unknown>) =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/cloudflare',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'cloudflare',
					description: 'Cloudflare package',
					jobs,
				},
			}),
		})
	await insertPublishedEntitySource({
		db: env.APP_DB as ReturnType<typeof createDatabase>,
		userId: input.userId,
		sourceId: input.sourceId,
		entityKind: 'package',
		entityId: input.packageId,
		publishedCommit: 'package-published-commit',
		manifestPath: 'package.json',
	})

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest({}),
		}),
	).toBe(false)

	const intervalJob = {
		'event-runner': {
			entry: './src/jobs/event-runner.ts',
			schedule: { type: 'interval', every: '15m' },
			timezone: 'America/Denver',
			enabled: true,
		},
	}
	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest(intervalJob),
		}),
	).toBe(true)
	const rowsAfterAdd = await listJobRowsByUserId(env.APP_DB, input.userId)
	expect(rowsAfterAdd).toHaveLength(1)
	expect(rowsAfterAdd[0]?.record.publishedCommit).toBe(
		'package-published-commit',
	)
	const nextRunAtAfterAdd = rowsAfterAdd[0]?.record.nextRunAt
	await refreshPackageJobRowIdentity({
		db: env.APP_DB,
		userId: input.userId,
		jobId: rowsAfterAdd[0]!.record.id,
		sourceId: input.sourceId,
		publishedCommit: null,
		callerContextJson: JSON.stringify({
			...rowsAfterAdd[0]!.callerContext,
			user: {
				...rowsAfterAdd[0]!.callerContext?.user,
				email: '',
			},
		}),
		updatedAt: rowsAfterAdd[0]!.record.updatedAt,
	})

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest(intervalJob),
		}),
	).toBe(false)
	const rowsAfterNoOp = await listJobRowsByUserId(env.APP_DB, input.userId)
	expect(rowsAfterNoOp[0]?.record.nextRunAt).toBe(nextRunAtAfterAdd)
	expect(rowsAfterNoOp[0]?.record.publishedCommit).toBe(
		'package-published-commit',
	)
	expect(rowsAfterNoOp[0]?.callerContext?.user.email).toBe('user-1@example.com')

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest({
				'event-runner': {
					...intervalJob['event-runner'],
					schedule: { type: 'interval', every: '30m' },
				},
			}),
		}),
	).toBe(true)
	const rowsAfterUpdate = await listJobRowsByUserId(env.APP_DB, input.userId)
	expect(rowsAfterUpdate[0]?.record.schedule).toEqual({
		type: 'interval',
		every: '30m',
	})

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest({}),
		}),
	).toBe(true)
	expect(await listJobRowsByUserId(env.APP_DB, input.userId)).toEqual([])
})

test('package job sync preserves a runtime-enabled job when the manifest still says disabled', async () => {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
	})
	const input = {
		env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		packageId: 'package-1',
		sourceId: 'source-1',
	}
	const createManifest = (enabled: boolean) =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/cloudflare',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'cloudflare',
					description: 'Cloudflare package',
					jobs: {
						sweep: {
							entry: './src/jobs/sweep.ts',
							schedule: { type: 'interval', every: '15m' },
							timezone: 'UTC',
							enabled,
						},
					},
				},
			}),
		})
	await insertPublishedEntitySource({
		db: env.APP_DB as ReturnType<typeof createDatabase>,
		userId: input.userId,
		sourceId: input.sourceId,
		entityKind: 'package',
		entityId: input.packageId,
		publishedCommit: 'package-published-commit',
		manifestPath: 'package.json',
	})

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest(false),
		}),
	).toBe(true)
	const created = (await listJobRowsByUserId(env.APP_DB, input.userId))[0]
	expect(created?.record.enabled).toBe(false)

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest(true),
		}),
	).toBe(true)
	const turnedOn = (await listJobRowsByUserId(env.APP_DB, input.userId))[0]
	expect(turnedOn?.record.enabled).toBe(true)
	const nextRunAtAfterEnable = turnedOn?.record.nextRunAt

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest(false),
		}),
	).toBe(false)
	const preserved = (await listJobRowsByUserId(env.APP_DB, input.userId))[0]
	expect(preserved?.record.enabled).toBe(true)
	expect(preserved?.record.nextRunAt).toBe(nextRunAtAfterEnable)
})

test('package job sync preflights the full addition set without partial inserts', async () => {
	const email = 'package-sync-free@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const now = '2026-08-08T12:00:00.000Z'
	const existingJobCount = planLimits.free.maxScheduledJobs - 1
	const db = createDatabase({
		users: [{ email, plan: 'free', stable_user_id: userId }],
		jobs: Array.from({ length: existingJobCount }, (_, index) => ({
			id: `existing-${index}`,
			user_id: userId,
			name: `Existing ${index}`,
			source_id: `existing-source-${index}`,
			published_commit: 'existing-commit',
			repo_check_policy_json: null,
			storage_id: `job:existing-${index}`,
			params_json: null,
			schedule_json: JSON.stringify({ type: 'interval', every: '1h' }),
			timezone: 'UTC',
			enabled: 1,
			kill_switch_enabled: 0,
			preserved: 0,
			expires_at: null,
			caller_context_json: JSON.stringify(
				createPlanUserCallerContext({ userId, email }),
			),
			created_at: now,
			updated_at: now,
			last_run_at: null,
			last_run_status: null,
			next_run_at: '2026-08-08T13:00:00.000Z',
		})),
	})
	const env = createJobServiceTestEnv({ APP_DB: db })
	await insertPublishedEntitySource({
		db,
		userId,
		sourceId: 'new-package-source',
		entityKind: 'package',
		entityId: 'new-package',
		publishedCommit: 'new-package-commit',
		manifestPath: 'package.json',
	})
	const manifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@owner/new-package',
			exports: { '.': './index.ts' },
			kody: {
				id: 'new-package',
				description: 'Package entitlement test',
				jobs: {
					first: {
						entry: './first.ts',
						schedule: { type: 'interval', every: '1h' },
					},
					second: {
						entry: './second.ts',
						schedule: { type: 'interval', every: '1h' },
					},
				},
			},
		}),
	})

	const error = await syncPackageJobsForPackage({
		env,
		userId,
		baseUrl: 'https://heykody.dev',
		packageId: 'new-package',
		sourceId: 'new-package-source',
		manifest,
	}).catch((caught: unknown) => caught)
	expect(isEntitlementLimitError(error)).toBe(true)
	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected package sync to enforce the scheduled job limit.')
	}
	expect(error.details).toMatchObject({
		resource: 'scheduled_jobs',
		plan: 'free',
		limit: planLimits.free.maxScheduledJobs,
		current: existingJobCount,
	})
	expect(await listJobRowsByUserId(db, userId)).toHaveLength(existingJobCount)
})

test('free plan rejects new or changed schedules faster than 15 minutes and grandfathers existing jobs', async () => {
	const email = 'interval-floor@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const paidEmail = 'interval-floor-paid@example.com'
	const paidUserId = await createStableUserIdFromEmail(paidEmail)
	identityMockModule.resolveBackgroundMcpUser.mockImplementation(
		async (_db: D1Database, id: string) => ({
			userId: id,
			email:
				id === paidUserId
					? paidEmail
					: id === userId
						? email
						: `${id}@example.com`,
			username: id,
			displayName: id,
		}),
	)
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase({
			users: [
				{ email, plan: 'free', stable_user_id: userId },
				{
					email: paidEmail,
					plan: 'standard',
					stripe_plan: 'standard',
					entitlement_ladder: 'legacy',
					stable_user_id: paidUserId,
				},
			],
		}),
	})
	const callerContext = createPlanUserCallerContext({ userId, email })

	await expect(
		syncSinglePackageJob({
			env,
			userId,
			baseUrl: 'https://example.com',
			packageId: 'too-fast-package',
			sourceId: 'too-fast-package-source',
			jobName: 'quota-job',
			schedule: { type: 'interval', every: '5m' },
		}),
	).rejects.toSatisfy((error: unknown) => isJobIntervalFloorError(error))

	const created = await syncSinglePackageJob({
		env,
		userId,
		baseUrl: 'https://example.com',
		packageId: 'ok-interval-package',
		sourceId: 'ok-interval-package-source',
		jobName: 'ok-job',
		schedule: { type: 'interval', every: '15m' },
	})
	expect(created.schedule).toEqual({ type: 'interval', every: '15m' })

	const grandfathered = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Legacy five-minute poller',
			schedule: { type: 'interval', every: '5m' },
			sourceId: 'legacy-5m-source',
		},
	})
	await expect(
		updateJob({
			env,
			callerContext,
			body: { id: grandfathered.id, enabled: false },
		}),
	).resolves.toMatchObject({ enabled: false })
	await expect(
		updateJob({
			env,
			callerContext,
			body: {
				id: grandfathered.id,
				schedule: { type: 'interval', every: '1m' },
			},
		}),
	).rejects.toSatisfy((error: unknown) => isJobIntervalFloorError(error))
	await expect(
		updateJob({
			env,
			callerContext,
			body: {
				id: grandfathered.id,
				timezone: 'America/Denver',
			},
		}),
	).rejects.toSatisfy((error: unknown) => isJobIntervalFloorError(error))

	const paidCreated = await syncSinglePackageJob({
		env,
		userId: paidUserId,
		baseUrl: 'https://example.com',
		packageId: 'paid-fast-package',
		sourceId: 'paid-fast-package-source',
		jobName: 'fast-job',
		schedule: { type: 'interval', every: '1m' },
	})
	expect(paidCreated.schedule).toEqual({ type: 'interval', every: '1m' })
})

test('public Standard rejects new schedules faster than 15 minutes', async () => {
	const email = 'public-standard-interval@example.com'
	const userId = await createStableUserIdFromEmail(email)
	identityMockModule.resolveBackgroundMcpUser.mockImplementation(
		async (_db: D1Database, id: string) => ({
			userId: id,
			email: id === userId ? email : `${id}@example.com`,
			username: id,
			displayName: id,
		}),
	)
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase({
			users: [
				{
					email,
					plan: 'free',
					stripe_plan: 'standard',
					entitlement_ladder: 'public',
					stable_user_id: userId,
				},
			],
		}),
	})
	await expect(
		syncSinglePackageJob({
			env,
			userId,
			baseUrl: 'https://example.com',
			packageId: 'public-standard-fast',
			sourceId: 'public-standard-fast-source',
			jobName: 'fast-job',
			schedule: { type: 'interval', every: '5m' },
		}),
	).rejects.toSatisfy((error: unknown) => isJobIntervalFloorError(error))
	const created = await syncSinglePackageJob({
		env,
		userId,
		baseUrl: 'https://example.com',
		packageId: 'public-standard-ok',
		sourceId: 'public-standard-ok-source',
		jobName: 'ok-job',
		schedule: { type: 'interval', every: '15m' },
	})
	expect(created.schedule).toEqual({ type: 'interval', every: '15m' })
})

test('package job sync preflights interval floors so a later invalid job writes nothing', async () => {
	const email = 'interval-preflight@example.com'
	const userId = await createStableUserIdFromEmail(email)
	identityMockModule.resolveBackgroundMcpUser.mockImplementation(
		async (_db: D1Database, id: string) => ({
			userId: id,
			email: id === userId ? email : `${id}@example.com`,
			username: id,
			displayName: id,
		}),
	)
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase({
			users: [{ email, plan: 'free', stable_user_id: userId }],
		}),
	})
	await insertPublishedEntitySource({
		db: env.APP_DB as ReturnType<typeof createDatabase>,
		userId,
		sourceId: 'mixed-interval-source',
		entityKind: 'package',
		entityId: 'mixed-interval-package',
		publishedCommit: 'mixed-interval-commit',
		manifestPath: 'package.json',
	})
	const before = await listJobRowsByUserId(env.APP_DB, userId)
	await expect(
		syncPackageJobsForPackage({
			env,
			userId,
			baseUrl: 'https://example.com',
			packageId: 'mixed-interval-package',
			sourceId: 'mixed-interval-source',
			manifest: parseAuthoredPackageJson({
				content: JSON.stringify({
					name: '@owner/mixed-interval-package',
					exports: { '.': './index.ts' },
					kody: {
						id: 'mixed-interval-package',
						description: 'Mixed interval jobs',
						jobs: {
							'ok-job': {
								entry: './ok.ts',
								schedule: { type: 'interval', every: '15m' },
							},
							'too-fast-job': {
								entry: './fast.ts',
								schedule: { type: 'interval', every: '5m' },
							},
						},
					},
				}),
			}),
		}),
	).rejects.toSatisfy((error: unknown) => isJobIntervalFloorError(error))
	expect(await listJobRowsByUserId(env.APP_DB, userId)).toEqual(before)
})

function createPlanUserCallerContext(input: { userId: string; email: string }) {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: input.userId,
			email: input.email,
			displayName: 'Plan User',
		},
		storageContext: {
			sessionId: null,
			appId: 'app-123',
		},
	}) as PersistedJobCallerContext
}

async function trySyncQuotaPackageJob(input: {
	env: Env
	userId: string
	packageId: string
}) {
	return syncSinglePackageJob({
		env: input.env,
		userId: input.userId,
		baseUrl: 'https://example.com',
		packageId: input.packageId,
		sourceId: `${input.packageId}-source`,
		jobName: 'quota-job',
	}).then(
		(job) => job,
		(thrown: unknown) => thrown,
	)
}

test('syncPackageJobsForPackage enforces scheduled job entitlements for plan users and denies at the max plan ceiling', async () => {
	const plannedEmail = 'planned@example.com'
	const plannedUserId = await createStableUserIdFromEmail(plannedEmail)
	const maxEmail = 'max@example.com'
	const maxUserId = await createStableUserIdFromEmail(maxEmail)
	identityMockModule.resolveBackgroundMcpUser.mockImplementation(
		async (_db: D1Database, userId: string) => ({
			userId,
			email:
				userId === plannedUserId
					? plannedEmail
					: userId === maxUserId
						? maxEmail
						: `${userId}@example.com`,
			username: userId,
			displayName: userId,
		}),
	)
	const plannedEnv = createJobServiceTestEnv({
		APP_DB: createDatabase({
			users: [
				{
					email: plannedEmail,
					plan: 'free',
					stable_user_id: plannedUserId,
				},
			],
		}),
	})
	const plannedCallerContext = createPlanUserCallerContext({
		userId: plannedUserId,
		email: plannedEmail,
	})
	const freeLimit = planLimits.free.maxScheduledJobs

	for (let index = 0; index < freeLimit; index += 1) {
		await insertLeftoverJob({
			env: plannedEnv,
			callerContext: plannedCallerContext,
			body: {
				name: `Quota job ${index}`,
				schedule: {
					type: 'interval',
					every: '15m',
				},
			},
		})
	}

	const freeError = await trySyncQuotaPackageJob({
		env: plannedEnv,
		userId: plannedUserId,
		packageId: 'free-quota-package',
	})
	if (!isEntitlementLimitError(freeError)) {
		throw new Error(
			'Expected an EntitlementLimitError from syncPackageJobsForPackage.',
		)
	}
	expect(freeError.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'scheduled_jobs',
		plan: 'free',
		limit: freeLimit,
		current: freeLimit,
	})

	const maxLimit = planLimits.max.maxScheduledJobs
	const belowMaxEnv = createJobServiceTestEnv({
		APP_DB: createDatabase({
			users: [{ email: maxEmail, plan: 'max', stable_user_id: maxUserId }],
			jobs: Array.from(
				{ length: planLimits.pro.maxScheduledJobs },
				(_, index) => ({
					id: `below-max-job-${index}`,
					user_id: maxUserId,
				}),
			),
		}),
	})
	const belowMaxJob = await trySyncQuotaPackageJob({
		env: belowMaxEnv,
		userId: maxUserId,
		packageId: 'below-max-package',
	})
	if (isEntitlementLimitError(belowMaxJob)) {
		throw new Error(
			'Expected package job sync below the max ceiling to succeed.',
		)
	}
	expect(belowMaxJob).toMatchObject({ name: 'quota-job' })

	const atCeilingEnv = createJobServiceTestEnv({
		APP_DB: createDatabase({
			users: [{ email: maxEmail, plan: 'max', stable_user_id: maxUserId }],
			jobs: Array.from({ length: maxLimit }, (_, index) => ({
				id: `max-job-${index}`,
				user_id: maxUserId,
			})),
		}),
	})
	const maxError = await trySyncQuotaPackageJob({
		env: atCeilingEnv,
		userId: maxUserId,
		packageId: 'max-quota-package',
	})
	if (!isEntitlementLimitError(maxError)) {
		throw new Error('Expected an EntitlementLimitError at the max job ceiling.')
	}
	expect(maxError.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'scheduled_jobs',
		plan: 'max',
		limit: maxLimit,
		current: maxLimit,
	})
})

test('blank-email package context uses the max plan for storage writes and nested job scheduling', async () => {
	const email = 'package-owner@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const meter = createInMemoryUserMeterEnv()
	const db = createDatabase({
		users: [{ email, plan: 'max', stable_user_id: userId }],
		jobs: Array.from(
			{ length: planLimits.free.maxScheduledJobs },
			(_, index) => ({
				id: `existing-job-${index}`,
				user_id: userId,
			}),
		),
	})
	const env = createJobServiceTestEnv({ APP_DB: db }, meter)
	mockRepoPersistence()
	await meter.seedStorageBytes({
		userId,
		bytes: planLimits.free.maxStorageBytes + 1,
	})
	const stalePackageContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		executionOrigin: 'background',
		user: {
			userId,
			email: '',
			displayName: 'Package Owner',
		},
		storageContext: {
			sessionId: null,
			appId: 'package-1',
			packageId: 'package-1',
			storageId: 'job:package-job:package-1:parent',
		},
	}) as PersistedJobCallerContext

	await expect(
		saveValue({
			env,
			userId,
			userEmail: stalePackageContext.user.email,
			scope: 'app',
			name: 'checkpoint',
			value: 'stored above the free-plan byte limit',
			storageContext: stalePackageContext.storageContext,
		}),
	).resolves.toMatchObject({ name: 'checkpoint' })
	identityMockModule.resolveBackgroundMcpUser.mockResolvedValueOnce({
		userId,
		email,
		username: userId,
		displayName: 'Package Owner',
	})
	await expect(
		syncSinglePackageJob({
			env,
			userId,
			baseUrl: stalePackageContext.baseUrl,
			packageId: 'nested-schedule-package',
			sourceId: 'nested-schedule-source',
			jobName: 'quota-job',
		}),
	).resolves.toMatchObject({ name: 'quota-job' })
})
