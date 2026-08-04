/**
 * Non-destructive admin production sweep: keyset-page all non-deleting users,
 * optionally seed D1 → RunLog legacy inventory, then content-free parity-check.
 *
 * Workflow/job D1 pages are processed incrementally (import/verify per page) so
 * a single large user cannot accumulate unbounded inventory in memory. Output
 * is counts/booleans/stable ids only — never emails, names, workflow names,
 * package ids, job ids, errors, or other user-authored content.
 */

import { planLimits } from '#worker/entitlements/plans.ts'
import {
	emptyLegacyParityBucketCounts,
	legacyParityVerifyMaxBatch,
	type LegacyParityBucketCounts,
	type LegacyParityWorkflowCheck,
} from '#worker/run-records/legacy-parity.ts'
import { activationMilestoneValues } from '#worker/run-records/package-activation-state.ts'
import {
	importActivationState,
	importWorkflowProjections,
	jobRunObservabilitySeedMaxBatch,
	seedJobRunObservabilityBatch,
	verifyLegacyParity,
	workflowBindingNames,
	type ActivationMilestone,
	type ActivationStateImport,
	type JobRunObservabilitySeedInput,
	type WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'

/**
 * Hard max users per capability call. Kept small because activation is a
 * one-shot bounded snapshot up to {@link adminRunLogLegacySeedActivationMaxPackages}
 * package rows per user.
 */
export const adminRunLogLegacySeedMaxUserLimit = 5

/** Default page size — one user so a max-plan activation snapshot stays cheap. */
export const adminRunLogLegacySeedDefaultUserLimit = 1

/**
 * Default workflow_runs D1 page size and per-import RPC batch for admin sweeps.
 * Kept well below the RunLog DO hard cap so large inventories paginate through
 * multiple import+verify rounds instead of one oversized RPC.
 */
export const adminRunLogLegacySeedDefaultWorkflowImportPageSize = 250

/**
 * One-shot activation package-row hard cap: maximum product plan saved-package
 * ceiling. Oversized D1 inventories fail closed (LIMIT cap+1 detection).
 */
export const adminRunLogLegacySeedActivationMaxPackages =
	planLimits.max.maxSavedPackages

/**
 * Intrinsic activation milestone hard cap (known milestone names only).
 * Oversized D1 inventories fail closed (LIMIT cap+1 detection).
 */
export const adminRunLogLegacySeedActivationMaxMilestones =
	activationMilestoneValues.length

export type AdminRunLogLegacySeedAction = 'status' | 'seed'

export type AdminRunLogLegacySeedEnv = {
	APP_DB: D1Database
	RUN_LOG: DurableObjectNamespace
}

export type AdminRunLogLegacySeedUserResult = {
	stableUserId: string
	/**
	 * True when this user's sweep threw (D1/RPC/cap). Failed users are not
	 * production evidence and must be rerun; bucket counts are zeroed.
	 */
	failed: boolean
	parity: boolean
	activationInitialized: boolean
	workflows: LegacyParityBucketCounts
	jobs: LegacyParityBucketCounts
	activationPackages: LegacyParityBucketCounts
	activationMilestones: LegacyParityBucketCounts
}

type AdminRunLogLegacySeedPageFields = {
	generatedAt: string
	users: Array<AdminRunLogLegacySeedUserResult>
	usersAttempted: number
	usersAtParity: number
	nextStartAfter: string | null
	truncated: boolean
}

export type AdminRunLogLegacySeedResult =
	| ({ action: 'status' } & AdminRunLogLegacySeedPageFields)
	| ({ action: 'seed' } & AdminRunLogLegacySeedPageFields)

export type AdminRunLogLegacySeedBatchSizes = {
	/** Max workflow projections per D1 page / import RPC (default 250). */
	workflowImport: number
	/** Max job seeds per D1 page / seed RPC (default 500). */
	jobSeed: number
	/** Max entries per verifyLegacyParity array (default 500). */
	verify: number
	/**
	 * Max activation package rows in the one-shot snapshot (default
	 * {@link adminRunLogLegacySeedActivationMaxPackages}).
	 */
	activationMaxPackages: number
	/**
	 * Max activation milestone rows in the one-shot snapshot (default
	 * {@link adminRunLogLegacySeedActivationMaxMilestones}).
	 */
	activationMaxMilestones: number
}

export type AdminRunLogLegacySeedRpc = {
	importWorkflowProjections: typeof importWorkflowProjections
	seedJobRunObservabilityBatch: typeof seedJobRunObservabilityBatch
	importActivationState: typeof importActivationState
	verifyLegacyParity: typeof verifyLegacyParity
}

const defaultRpc: AdminRunLogLegacySeedRpc = {
	importWorkflowProjections,
	seedJobRunObservabilityBatch,
	importActivationState,
	verifyLegacyParity,
}

const defaultBatchSizes: AdminRunLogLegacySeedBatchSizes = {
	workflowImport: adminRunLogLegacySeedDefaultWorkflowImportPageSize,
	jobSeed: jobRunObservabilitySeedMaxBatch,
	verify: legacyParityVerifyMaxBatch,
	activationMaxPackages: adminRunLogLegacySeedActivationMaxPackages,
	activationMaxMilestones: adminRunLogLegacySeedActivationMaxMilestones,
}

type D1WorkflowRunRow = {
	id: string
	user_id: string
	source_type: string
	package_id: string | null
	kody_id: string | null
	source_id: string | null
	workflow_name: string
	export_name: string | null
	idempotency_key: string
	run_at: string
	plan_date: string | null
	status: string | null
	created_at: string
	updated_at: string
	completed_at: string | null
	last_error: string | null
}

type D1JobObservabilityRow = {
	id: string
	last_run_at: string | null
	last_run_status: string | null
	last_run_error: string | null
	last_duration_ms: number | null
	run_count: number
	success_count: number
	error_count: number
	updated_at: string
}

type D1ActivationPackageRow = {
	package_id: string
	success_count: number
	updated_at: string
}

type D1ActivationMilestoneRow = {
	milestone: string
	reached_at: string
	package_id: string | null
}

type AggregatedParity = {
	workflows: LegacyParityBucketCounts
	jobs: LegacyParityBucketCounts
	activationPackages: LegacyParityBucketCounts
	activationMilestones: LegacyParityBucketCounts
	activationInitialized: boolean
}

function clampUserLimit(limit: number | undefined): number {
	const requested = limit ?? adminRunLogLegacySeedDefaultUserLimit
	if (!Number.isFinite(requested)) {
		return adminRunLogLegacySeedDefaultUserLimit
	}
	return Math.max(
		1,
		Math.min(adminRunLogLegacySeedMaxUserLimit, Math.trunc(requested)),
	)
}

function clampBatchSize(value: number | undefined, fallback: number): number {
	if (value == null || !Number.isFinite(value)) return fallback
	return Math.max(1, Math.min(fallback, Math.trunc(value)))
}

function resolveBatchSizes(
	overrides?: Partial<AdminRunLogLegacySeedBatchSizes>,
): AdminRunLogLegacySeedBatchSizes {
	return {
		workflowImport: clampBatchSize(
			overrides?.workflowImport,
			defaultBatchSizes.workflowImport,
		),
		jobSeed: clampBatchSize(overrides?.jobSeed, defaultBatchSizes.jobSeed),
		verify: clampBatchSize(overrides?.verify, defaultBatchSizes.verify),
		activationMaxPackages: clampBatchSize(
			overrides?.activationMaxPackages,
			defaultBatchSizes.activationMaxPackages,
		),
		activationMaxMilestones: clampBatchSize(
			overrides?.activationMaxMilestones,
			defaultBatchSizes.activationMaxMilestones,
		),
	}
}

function failedUserResult(
	stableUserId: string,
): AdminRunLogLegacySeedUserResult {
	return {
		stableUserId,
		failed: true,
		parity: false,
		activationInitialized: false,
		workflows: emptyLegacyParityBucketCounts(),
		jobs: emptyLegacyParityBucketCounts(),
		activationPackages: emptyLegacyParityBucketCounts(),
		activationMilestones: emptyLegacyParityBucketCounts(),
	}
}

function addBucketCounts(
	left: LegacyParityBucketCounts,
	right: LegacyParityBucketCounts,
): LegacyParityBucketCounts {
	return {
		matched: left.matched + right.matched,
		missing: left.missing + right.missing,
		underCount: left.underCount + right.underCount,
	}
}

function bucketParityHolds(counts: LegacyParityBucketCounts): boolean {
	return counts.missing === 0 && counts.underCount === 0
}

function chunkArray<T>(items: ReadonlyArray<T>, size: number): Array<Array<T>> {
	if (items.length === 0) return []
	const chunks: Array<Array<T>> = []
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size))
	}
	return chunks
}

/**
 * List non-deleting users by stable_user_id keyset. Intentionally includes
 * every active account (not only users with legacy D1 inventory) so "all
 * active users" sweeps are falsifiable.
 *
 * Callers that need exact truncation should request `limit + 1` rows and slice.
 */
export async function listUsersForAdminRunLogLegacySeed(input: {
	db: D1Database
	limit: number
	startAfterUserId?: string | null
}): Promise<Array<{ userId: string }>> {
	const startAfter = input.startAfterUserId ?? null
	const result = startAfter
		? await input.db
				.prepare(
					`SELECT u.stable_user_id AS userId
					FROM users u
					WHERE u.deleting_at IS NULL
						AND u.stable_user_id IS NOT NULL
						AND u.stable_user_id > ?
					ORDER BY u.stable_user_id ASC
					LIMIT ?`,
				)
				.bind(startAfter, input.limit)
				.all<{ userId: string }>()
		: await input.db
				.prepare(
					`SELECT u.stable_user_id AS userId
					FROM users u
					WHERE u.deleting_at IS NULL
						AND u.stable_user_id IS NOT NULL
					ORDER BY u.stable_user_id ASC
					LIMIT ?`,
				)
				.bind(input.limit)
				.all<{ userId: string }>()
	return result.results ?? []
}

function mapWorkflowProjection(
	row: D1WorkflowRunRow,
): WorkflowProjectionUpsertInput {
	const sourceType = row.source_type
	if (sourceType !== 'inline' && sourceType !== 'package') {
		throw new Error('Unknown workflow source_type in legacy inventory')
	}
	return {
		id: String(row.id),
		bindingName: workflowBindingNames[0],
		sourceType,
		packageId: row.package_id == null ? null : String(row.package_id),
		kodyId: row.kody_id == null ? null : String(row.kody_id),
		sourceId: row.source_id == null ? null : String(row.source_id),
		workflowName: String(row.workflow_name),
		exportName: row.export_name == null ? null : String(row.export_name),
		idempotencyKey: String(row.idempotency_key),
		runAt: String(row.run_at),
		planDate: row.plan_date == null ? null : String(row.plan_date),
		status: row.status == null ? null : String(row.status),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		completedAt: row.completed_at == null ? null : String(row.completed_at),
		lastError: row.last_error == null ? null : String(row.last_error),
	}
}

function mapWorkflowParityCheck(
	row: D1WorkflowRunRow,
): LegacyParityWorkflowCheck {
	return {
		id: String(row.id),
		minimumUpdatedAt: String(row.updated_at),
	}
}

function mapJobSeed(row: D1JobObservabilityRow): JobRunObservabilitySeedInput {
	const lastRunStatus =
		row.last_run_status === 'success' || row.last_run_status === 'error'
			? row.last_run_status
			: null
	return {
		jobId: String(row.id),
		lastRunAt: row.last_run_at == null ? null : String(row.last_run_at),
		lastRunStatus,
		lastRunError:
			row.last_run_error == null ? null : String(row.last_run_error),
		lastDurationMs:
			row.last_duration_ms == null ? null : Number(row.last_duration_ms) || 0,
		runCount: Number(row.run_count) || 0,
		successCount: Number(row.success_count) || 0,
		errorCount: Number(row.error_count) || 0,
		updatedAt: String(row.updated_at),
	}
}

function mapActivationState(input: {
	packages: ReadonlyArray<D1ActivationPackageRow>
	milestones: ReadonlyArray<D1ActivationMilestoneRow>
}): ActivationStateImport {
	return {
		packageRunSuccesses: input.packages.map((row) => ({
			packageId: String(row.package_id),
			successCount: Number(row.success_count) || 0,
			updatedAt: String(row.updated_at),
		})),
		milestones: input.milestones
			.filter(
				(row) =>
					row.milestone === 'package_run_succeeded' ||
					row.milestone === 'package_activated',
			)
			.map((row) => ({
				milestone: row.milestone as ActivationMilestone,
				reachedAt: String(row.reached_at),
				packageId: row.package_id == null ? null : String(row.package_id),
			})),
	}
}

async function fetchWorkflowPage(input: {
	db: D1Database
	userId: string
	pageSize: number
	startAfterId: string | null
}): Promise<Array<D1WorkflowRunRow>> {
	let page: D1Result<D1WorkflowRunRow>
	if (input.startAfterId) {
		page = await input.db
			.prepare(
				`SELECT id, user_id, source_type, package_id, kody_id, source_id,
					workflow_name, export_name, idempotency_key, run_at, plan_date,
					status, created_at, updated_at, completed_at, last_error
				FROM workflow_runs
				WHERE user_id = ? AND id > ?
				ORDER BY id ASC
				LIMIT ?`,
			)
			.bind(input.userId, input.startAfterId, input.pageSize)
			.all<D1WorkflowRunRow>()
	} else {
		page = await input.db
			.prepare(
				`SELECT id, user_id, source_type, package_id, kody_id, source_id,
					workflow_name, export_name, idempotency_key, run_at, plan_date,
					status, created_at, updated_at, completed_at, last_error
				FROM workflow_runs
				WHERE user_id = ?
				ORDER BY id ASC
				LIMIT ?`,
			)
			.bind(input.userId, input.pageSize)
			.all<D1WorkflowRunRow>()
	}
	return page.results ?? []
}

async function fetchJobPage(input: {
	db: D1Database
	userId: string
	pageSize: number
	startAfterId: string | null
}): Promise<Array<D1JobObservabilityRow>> {
	let page: D1Result<D1JobObservabilityRow>
	if (input.startAfterId) {
		page = await input.db
			.prepare(
				`SELECT id, last_run_at, last_run_status, last_run_error,
					last_duration_ms, run_count, success_count, error_count, updated_at
				FROM jobs
				WHERE user_id = ? AND id > ?
				ORDER BY id ASC
				LIMIT ?`,
			)
			.bind(input.userId, input.startAfterId, input.pageSize)
			.all<D1JobObservabilityRow>()
	} else {
		page = await input.db
			.prepare(
				`SELECT id, last_run_at, last_run_status, last_run_error,
					last_duration_ms, run_count, success_count, error_count, updated_at
				FROM jobs
				WHERE user_id = ?
				ORDER BY id ASC
				LIMIT ?`,
			)
			.bind(input.userId, input.pageSize)
			.all<D1JobObservabilityRow>()
	}
	return page.results ?? []
}

async function verifyWorkflowChecks(input: {
	env: AdminRunLogLegacySeedEnv
	userId: string
	checks: ReadonlyArray<LegacyParityWorkflowCheck>
	verifyBatchSize: number
	rpc: AdminRunLogLegacySeedRpc
}): Promise<{
	counts: LegacyParityBucketCounts
	activationInitialized: boolean
}> {
	let counts = emptyLegacyParityBucketCounts()
	let activationInitialized = false
	for (const workflows of chunkArray(input.checks, input.verifyBatchSize)) {
		const result = await input.rpc.verifyLegacyParity({
			env: input.env as Env,
			userId: input.userId,
			workflows,
		})
		counts = addBucketCounts(counts, result.workflows)
		activationInitialized =
			activationInitialized || result.activationInitialized
	}
	return { counts, activationInitialized }
}

async function verifyJobIds(input: {
	env: AdminRunLogLegacySeedEnv
	userId: string
	jobIds: ReadonlyArray<string>
	verifyBatchSize: number
	rpc: AdminRunLogLegacySeedRpc
}): Promise<{
	counts: LegacyParityBucketCounts
	activationInitialized: boolean
}> {
	let counts = emptyLegacyParityBucketCounts()
	let activationInitialized = false
	for (const jobIds of chunkArray(input.jobIds, input.verifyBatchSize)) {
		const result = await input.rpc.verifyLegacyParity({
			env: input.env as Env,
			userId: input.userId,
			jobIds: [...jobIds],
		})
		counts = addBucketCounts(counts, result.jobs)
		activationInitialized =
			activationInitialized || result.activationInitialized
	}
	return { counts, activationInitialized }
}

/**
 * Keyset-page workflow_runs and process each page immediately: seed imports the
 * page, then status/seed verifies it (with minimumUpdatedAt) without retaining
 * prior pages.
 */
async function processWorkflowPages(input: {
	env: AdminRunLogLegacySeedEnv
	userId: string
	action: AdminRunLogLegacySeedAction
	batchSizes: AdminRunLogLegacySeedBatchSizes
	rpc: AdminRunLogLegacySeedRpc
}): Promise<{
	counts: LegacyParityBucketCounts
	activationInitialized: boolean
}> {
	let counts = emptyLegacyParityBucketCounts()
	let activationInitialized = false
	let startAfterId: string | null = null
	for (;;) {
		const rows = await fetchWorkflowPage({
			db: input.env.APP_DB,
			userId: input.userId,
			pageSize: input.batchSizes.workflowImport,
			startAfterId,
		})
		if (rows.length === 0) break

		switch (input.action) {
			case 'status':
				break
			case 'seed': {
				await input.rpc.importWorkflowProjections({
					env: input.env as Env,
					userId: input.userId,
					projections: rows.map(mapWorkflowProjection),
				})
				break
			}
			default: {
				const exhaustive: never = input.action
				throw new Error(
					`Unhandled admin run-log legacy-seed action: ${JSON.stringify(exhaustive)}`,
				)
			}
		}

		const verified = await verifyWorkflowChecks({
			env: input.env,
			userId: input.userId,
			checks: rows.map(mapWorkflowParityCheck),
			verifyBatchSize: input.batchSizes.verify,
			rpc: input.rpc,
		})
		counts = addBucketCounts(counts, verified.counts)
		activationInitialized =
			activationInitialized || verified.activationInitialized

		const lastId = rows.at(-1)?.id
		if (!lastId || rows.length < input.batchSizes.workflowImport) break
		if (lastId === startAfterId) {
			throw new Error('workflow_runs keyset cursor did not advance')
		}
		startAfterId = lastId
	}
	return { counts, activationInitialized }
}

/**
 * Keyset-page jobs (including zero legacy observability) and process each page
 * immediately so seed marks every D1 job legacy_seeded without retaining the
 * full inventory.
 */
async function processJobPages(input: {
	env: AdminRunLogLegacySeedEnv
	userId: string
	action: AdminRunLogLegacySeedAction
	batchSizes: AdminRunLogLegacySeedBatchSizes
	rpc: AdminRunLogLegacySeedRpc
}): Promise<{
	counts: LegacyParityBucketCounts
	activationInitialized: boolean
}> {
	let counts = emptyLegacyParityBucketCounts()
	let activationInitialized = false
	let startAfterId: string | null = null
	for (;;) {
		const rows = await fetchJobPage({
			db: input.env.APP_DB,
			userId: input.userId,
			pageSize: input.batchSizes.jobSeed,
			startAfterId,
		})
		if (rows.length === 0) break

		switch (input.action) {
			case 'status':
				break
			case 'seed': {
				await input.rpc.seedJobRunObservabilityBatch({
					env: input.env as Env,
					userId: input.userId,
					seeds: rows.map(mapJobSeed),
				})
				break
			}
			default: {
				const exhaustive: never = input.action
				throw new Error(
					`Unhandled admin run-log legacy-seed action: ${JSON.stringify(exhaustive)}`,
				)
			}
		}

		const verified = await verifyJobIds({
			env: input.env,
			userId: input.userId,
			jobIds: rows.map((row) => String(row.id)),
			verifyBatchSize: input.batchSizes.verify,
			rpc: input.rpc,
		})
		counts = addBucketCounts(counts, verified.counts)
		activationInitialized =
			activationInitialized || verified.activationInitialized

		const lastId = rows.at(-1)?.id
		if (!lastId || rows.length < input.batchSizes.jobSeed) break
		if (lastId === startAfterId) {
			throw new Error('jobs keyset cursor did not advance')
		}
		startAfterId = lastId
	}
	return { counts, activationInitialized }
}

/**
 * Bounded one-shot activation snapshot. Packages are capped at the max product
 * plan saved-package ceiling; milestones use their intrinsic known-name count.
 * Each side uses LIMIT cap+1 so overflow fails closed without an unbounded load.
 */
async function readActivationInventory(input: {
	db: D1Database
	userId: string
	maxPackages: number
	maxMilestones: number
}): Promise<ActivationStateImport> {
	// Pre-drop evidence: any missing table/column must fail closed for the
	// user. Never treat a failed source query as an empty successful snapshot.
	const successRows = await input.db
		.prepare(
			`SELECT package_id, success_count, updated_at
			FROM user_package_run_successes
			WHERE user_id = ?
			ORDER BY package_id ASC
			LIMIT ?`,
		)
		.bind(input.userId, input.maxPackages + 1)
		.all<D1ActivationPackageRow>()
	const packages = successRows.results ?? []
	if (packages.length > input.maxPackages) {
		throw new Error('activation package inventory exceeds defensive hard cap')
	}

	// Only known milestone names count toward the intrinsic cap so
	// unknown/retired rows cannot exhaust the one-shot snapshot budget.
	const milestonePlaceholders = activationMilestoneValues
		.map(() => '?')
		.join(', ')
	const milestoneRows = await input.db
		.prepare(
			`SELECT milestone, reached_at, package_id
			FROM user_activation_milestones
			WHERE user_id = ?
				AND milestone IN (${milestonePlaceholders})
			ORDER BY milestone ASC
			LIMIT ?`,
		)
		.bind(input.userId, ...activationMilestoneValues, input.maxMilestones + 1)
		.all<D1ActivationMilestoneRow>()
	const milestones = milestoneRows.results ?? []
	if (milestones.length > input.maxMilestones) {
		throw new Error('activation milestone inventory exceeds defensive hard cap')
	}

	return mapActivationState({ packages, milestones })
}

async function processActivation(input: {
	env: AdminRunLogLegacySeedEnv
	userId: string
	action: AdminRunLogLegacySeedAction
	batchSizes: AdminRunLogLegacySeedBatchSizes
	rpc: AdminRunLogLegacySeedRpc
}): Promise<{
	activationPackages: LegacyParityBucketCounts
	activationMilestones: LegacyParityBucketCounts
	activationInitialized: boolean
}> {
	const activation = await readActivationInventory({
		db: input.env.APP_DB,
		userId: input.userId,
		maxPackages: input.batchSizes.activationMaxPackages,
		maxMilestones: input.batchSizes.activationMaxMilestones,
	})

	switch (input.action) {
		case 'status':
			break
		case 'seed':
			// Unconditional: empty legacy activation still marks initialized so
			// every non-deleting user can reach parity without D1 activation rows.
			await input.rpc.importActivationState({
				env: input.env as Env,
				userId: input.userId,
				state: activation,
			})
			break
		default: {
			const exhaustive: never = input.action
			throw new Error(
				`Unhandled admin run-log legacy-seed action: ${JSON.stringify(exhaustive)}`,
			)
		}
	}

	const activationPackages = activation.packageRunSuccesses.map((row) => ({
		packageId: row.packageId,
		minimumSuccessCount: row.successCount,
	}))
	const activationMilestones = activation.milestones.map((row) => row.milestone)
	const packageChunks =
		activationPackages.length === 0
			? [[]]
			: chunkArray(activationPackages, input.batchSizes.verify)
	const milestoneChunks =
		activationMilestones.length === 0
			? [[]]
			: chunkArray(activationMilestones, input.batchSizes.verify)
	const roundCount = Math.max(packageChunks.length, milestoneChunks.length)

	let packages = emptyLegacyParityBucketCounts()
	let milestones = emptyLegacyParityBucketCounts()
	let activationInitialized = false
	for (let round = 0; round < roundCount; round += 1) {
		const result = await input.rpc.verifyLegacyParity({
			env: input.env as Env,
			userId: input.userId,
			activationPackages: packageChunks[round] ?? [],
			activationMilestones: milestoneChunks[round] ?? [],
		})
		packages = addBucketCounts(packages, result.activationPackages)
		milestones = addBucketCounts(milestones, result.activationMilestones)
		activationInitialized =
			activationInitialized || result.activationInitialized
	}

	return {
		activationPackages: packages,
		activationMilestones: milestones,
		activationInitialized,
	}
}

function toUserResult(
	stableUserId: string,
	aggregated: AggregatedParity,
): AdminRunLogLegacySeedUserResult {
	const parity =
		aggregated.activationInitialized &&
		bucketParityHolds(aggregated.workflows) &&
		bucketParityHolds(aggregated.jobs) &&
		bucketParityHolds(aggregated.activationPackages) &&
		bucketParityHolds(aggregated.activationMilestones)
	return {
		stableUserId,
		failed: false,
		parity,
		activationInitialized: aggregated.activationInitialized,
		workflows: aggregated.workflows,
		jobs: aggregated.jobs,
		activationPackages: aggregated.activationPackages,
		activationMilestones: aggregated.activationMilestones,
	}
}

async function processUser(input: {
	env: AdminRunLogLegacySeedEnv
	userId: string
	action: AdminRunLogLegacySeedAction
	batchSizes: AdminRunLogLegacySeedBatchSizes
	rpc: AdminRunLogLegacySeedRpc
}): Promise<AdminRunLogLegacySeedUserResult> {
	try {
		const workflows = await processWorkflowPages({
			env: input.env,
			userId: input.userId,
			action: input.action,
			batchSizes: input.batchSizes,
			rpc: input.rpc,
		})
		const jobs = await processJobPages({
			env: input.env,
			userId: input.userId,
			action: input.action,
			batchSizes: input.batchSizes,
			rpc: input.rpc,
		})
		const activation = await processActivation({
			env: input.env,
			userId: input.userId,
			action: input.action,
			batchSizes: input.batchSizes,
			rpc: input.rpc,
		})

		const aggregated: AggregatedParity = {
			workflows: workflows.counts,
			jobs: jobs.counts,
			activationPackages: activation.activationPackages,
			activationMilestones: activation.activationMilestones,
			activationInitialized:
				workflows.activationInitialized ||
				jobs.activationInitialized ||
				activation.activationInitialized,
		}
		return toUserResult(input.userId, aggregated)
	} catch (error) {
		// Fail closed for this user; never surface error text in the result.
		// Missing D1 relations/columns are failures in this pre-drop evidence
		// sweep — not successful empty inventory.
		console.warn('admin-run-log-legacy-seed-user-failed', {
			stableUserId: input.userId,
			error,
		})
		return failedUserResult(input.userId)
	}
}

/**
 * Keyset-paged status or seed sweep across all non-deleting users. Per-user
 * D1/RPC failures yield `parity: false` for that user and do not stop the page.
 */
export async function runAdminRunLogLegacySeed(input: {
	env: AdminRunLogLegacySeedEnv
	action: AdminRunLogLegacySeedAction
	limit?: number
	startAfterUserId?: string | null
	now?: Date
	/** Test seam: reduced batch sizes to exercise multi-RPC paging. */
	batchSizes?: Partial<AdminRunLogLegacySeedBatchSizes>
	/** Test seam: substitute RunLog RPC wrappers. */
	rpc?: Partial<AdminRunLogLegacySeedRpc>
}): Promise<AdminRunLogLegacySeedResult> {
	const action = input.action
	const now = input.now ?? new Date()
	const generatedAt = now.toISOString()
	const limit = clampUserLimit(input.limit)
	const startAfterUserId = input.startAfterUserId ?? null
	const batchSizes = resolveBatchSizes(input.batchSizes)
	const rpc: AdminRunLogLegacySeedRpc = {
		...defaultRpc,
		...input.rpc,
	}

	// Fetch limit+1 so truncation/nextStartAfter are exact when the last page
	// is exactly `limit` users (full page with nothing remaining).
	const fetched = await listUsersForAdminRunLogLegacySeed({
		db: input.env.APP_DB,
		limit: limit + 1,
		startAfterUserId,
	})
	const truncated = fetched.length > limit
	const owners = truncated ? fetched.slice(0, limit) : fetched

	const users: Array<AdminRunLogLegacySeedUserResult> = []
	for (const owner of owners) {
		users.push(
			await processUser({
				env: input.env,
				userId: owner.userId,
				action,
				batchSizes,
				rpc,
			}),
		)
	}

	const usersAttempted = users.length
	const usersAtParity = users.filter((user) => user.parity).length
	const nextStartAfter = truncated
		? (owners.at(-1)?.userId ?? startAfterUserId)
		: null

	switch (action) {
		case 'status':
			return {
				action: 'status',
				generatedAt,
				users,
				usersAttempted,
				usersAtParity,
				nextStartAfter,
				truncated,
			}
		case 'seed':
			return {
				action: 'seed',
				generatedAt,
				users,
				usersAttempted,
				usersAtParity,
				nextStartAfter,
				truncated,
			}
		default: {
			const exhaustive: never = action
			throw new Error(
				`Unhandled admin run-log legacy-seed action: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}
