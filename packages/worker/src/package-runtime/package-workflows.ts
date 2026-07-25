import { isoTimestampDayKey } from '@kody-internal/shared/date-keys.ts'
import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import {
	toJsonSafeValue,
	type JsonValue,
} from '@kody-internal/shared/json-safe-value.ts'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import * as Sentry from '@sentry/cloudflare'
import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { invokePackageExport } from '#worker/package-invocations/service.ts'
import { packageWorkflowInvocationSource } from './package-invocation-sources.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { listAttachedRemoteConnectorRefs } from '#worker/remote-connector/settings-service.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import {
	activeWorkflowStatusValues,
	terminalWorkflowStatusValues,
	type WorkflowRunStatus,
} from './workflow-statuses.ts'
import { applyDynamicWorkflowSentryScope } from './package-workflows-sentry.ts'

export type PackageWorkflowParams = Record<string, unknown>

type WorkflowCreateBaseInput = {
	workflowName?: string
	runAt?: string | Date
	idempotencyKey?: string
	params?: PackageWorkflowParams
}

export type PackageWorkflowCreateInput = WorkflowCreateBaseInput &
	(
		| {
				exportName: string
				packageId?: string
				code?: never
		  }
		| {
				code: string
				exportName?: never
				packageId?: never
		  }
	)

export type PackageWorkflowCreateResult = {
	ok: true
	id: string
	workflow_name: string
	source_type: 'package' | 'inline'
	package_id?: string | null
	export_name?: string | null
	run_at: string
	plan_date: string | null
	status?: string
}

export type DynamicCallableWorkflowPayload =
	| {
			version: 2
			sourceType: 'package'
			userId: string
			packageId: string
			kodyId: string
			sourceId: string
			workflowName: string
			exportName: string
			idempotencyKey: string
			runAt: string
			planDate: string | null
			params?: PackageWorkflowParams
	  }
	| {
			version: 3
			sourceType: 'inline'
			userId: string
			packageContext: {
				packageId: string
				kodyId: string
				sourceId?: string | null
			} | null
			workflowName: string
			code: string
			idempotencyKey: string
			runAt: string
			planDate: string | null
			params?: PackageWorkflowParams
	  }

export type WorkflowRunInspection = {
	id: string
	userId: string
	sourceType: 'package' | 'inline'
	packageId: string | null
	kodyId: string | null
	sourceId: string | null
	workflowName: string
	exportName: string | null
	idempotencyKey: string
	runAt: string
	planDate: string | null
	status: WorkflowRunStatus | null
	createdAt: string
	updatedAt: string
	completedAt: string | null
	lastError: string | null
}

type WorkflowStepDoConfig = {
	retries?: {
		limit: number
		delay: string | number
		backoff?: string
	}
	timeout?: string | number
}

const workflowStepDoConfig: WorkflowStepDoConfig = {
	retries: {
		limit: 3,
		delay: '30 seconds',
		backoff: 'exponential',
	},
	timeout: '5 minutes',
}

type DynamicCallableWorkflowStep = {
	do(
		name: string,
		config: WorkflowStepDoConfig,
		callback: () => Promise<JsonValue>,
	): Promise<JsonValue>
}

const packageWorkflowTokenId = 'internal:package-workflows'
const maxPackageWorkflowParamsJsonBytes = 16 * 1024
const workflowStatusRefreshTtlMs = 30_000
const creatingWorkflowRunStatus = 'creating'
const knownWorkflowStatusValues = [
	...activeWorkflowStatusValues,
	...terminalWorkflowStatusValues,
] as const
const activeWorkflowStatuses = new Set<string>(activeWorkflowStatusValues)
const terminalWorkflowStatuses = new Set<string>(terminalWorkflowStatusValues)
const knownWorkflowStatuses = new Set<string>(knownWorkflowStatusValues)

function getWorkflowInvocationErrorMessage(response: {
	status: number
	body: unknown
}) {
	const body = response.body
	const error =
		body && typeof body === 'object'
			? (body as Record<string, unknown>)['error']
			: null
	const message =
		error && typeof error === 'object'
			? (error as Record<string, unknown>)['message']
			: null
	return typeof message === 'string' && message.trim()
		? message
		: `Package workflow export failed with HTTP ${response.status}.`
}

function normalizeNonEmptyString(value: string, fieldName: string) {
	const trimmed = value.trim()
	if (!trimmed) {
		throw new Error(`${fieldName} must not be empty.`)
	}
	return trimmed
}

export function normalizeWorkflowExportName(exportName: string) {
	const trimmed = normalizeNonEmptyString(exportName, 'exportName')
	if (trimmed === '.' || trimmed === './') return '.'
	if (trimmed.startsWith('kody:')) return trimmed
	return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
}

function normalizeOptionalWorkflowName(
	workflowName: string | undefined,
	fallback: string,
) {
	return workflowName?.trim() || fallback
}

function normalizeRunAt(runAt: string | Date | undefined) {
	const date =
		runAt === undefined
			? new Date()
			: typeof runAt === 'string'
				? new Date(runAt)
				: runAt
	if (Number.isNaN(date.getTime())) {
		throw new Error('runAt must be a valid date or ISO string.')
	}
	return date.toISOString()
}

export function normalizePackageWorkflowParams(
	params: PackageWorkflowParams | null | undefined,
) {
	if (params == null) return undefined
	if (typeof params !== 'object' || Array.isArray(params)) {
		throw new Error('workflow params must be a JSON object when provided.')
	}
	const paramsJson = JSON.stringify(params)
	if (
		new TextEncoder().encode(paramsJson).byteLength >
		maxPackageWorkflowParamsJsonBytes
	) {
		throw new Error(
			`workflow params must be ${maxPackageWorkflowParamsJsonBytes} bytes or less when serialized.`,
		)
	}
	const normalized = JSON.parse(paramsJson) as unknown
	if (
		!normalized ||
		typeof normalized !== 'object' ||
		Array.isArray(normalized)
	) {
		throw new Error('workflow params must be a JSON object when provided.')
	}
	return normalized as PackageWorkflowParams
}

export async function createPackageWorkflowInstanceId(input: {
	userId: string
	packageId: string
	workflowName: string
	idempotencyKey: string
	runAt: string | Date
	options?: {
		includeRunAt?: boolean
	}
}) {
	const canonical = canonicalJsonStringify({
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		packageId: normalizeNonEmptyString(input.packageId, 'packageId'),
		workflowName: normalizeNonEmptyString(input.workflowName, 'workflowName'),
		idempotencyKey: normalizeNonEmptyString(
			input.idempotencyKey,
			'idempotencyKey',
		),
		...(input.options?.includeRunAt === false
			? {}
			: { runAt: normalizeRunAt(input.runAt) }),
	})
	return `pkgwf-${(await sha256Base64Url(canonical)).slice(0, 43)}`
}

export function createPackageWorkflowPlanDate(runAt: string | Date) {
	return isoTimestampDayKey(normalizeRunAt(runAt))
}

function normalizeWorkflowIdempotencyKey(idempotencyKey: string | undefined) {
	if (idempotencyKey !== undefined) {
		return normalizeNonEmptyString(idempotencyKey, 'idempotencyKey')
	}
	return `generated:${crypto.randomUUID()}`
}

function createInlineWorkflowPayload(input: {
	userId: string
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId?: string | null
	} | null
	workflowName?: string
	code: string
	idempotencyKey?: string
	runAt?: string | Date
	params?: PackageWorkflowParams | null
	planDate?: string | null
}): DynamicCallableWorkflowPayload {
	const runAt = normalizeRunAt(input.runAt)
	const idempotencyKey = normalizeWorkflowIdempotencyKey(input.idempotencyKey)
	const params = normalizePackageWorkflowParams(input.params)
	return {
		version: 3,
		sourceType: 'inline',
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		packageContext: input.packageContext ?? null,
		workflowName: normalizeOptionalWorkflowName(
			input.workflowName,
			'inline-code',
		),
		code: normalizeNonEmptyString(input.code, 'code'),
		idempotencyKey,
		runAt,
		planDate: input.planDate?.trim() || createPackageWorkflowPlanDate(runAt),
		...(params === undefined ? {} : { params }),
	}
}

function createDynamicPackageWorkflowPayload(input: {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	workflowName?: string
	exportName: string
	idempotencyKey?: string
	runAt?: string | Date
	params?: PackageWorkflowParams | null
	planDate?: string | null
}): DynamicCallableWorkflowPayload {
	const runAt = normalizeRunAt(input.runAt)
	const idempotencyKey = normalizeWorkflowIdempotencyKey(input.idempotencyKey)
	const params = normalizePackageWorkflowParams(input.params)
	const workflowName = normalizeNonEmptyString(
		normalizeOptionalWorkflowName(input.workflowName, input.exportName),
		'workflowName',
	)
	return {
		version: 2,
		sourceType: 'package',
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		packageId: normalizeNonEmptyString(input.packageId, 'packageId'),
		kodyId: normalizeNonEmptyString(input.kodyId, 'kodyId'),
		sourceId: normalizeNonEmptyString(input.sourceId, 'sourceId'),
		workflowName,
		exportName: normalizeWorkflowExportName(input.exportName),
		idempotencyKey,
		runAt,
		planDate: input.planDate?.trim() || createPackageWorkflowPlanDate(runAt),
		...(params === undefined ? {} : { params }),
	}
}

function validateDynamicCallableWorkflowPayload(
	input: unknown,
): DynamicCallableWorkflowPayload {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new Error('Dynamic callable workflow payload must be an object.')
	}
	const record = input as Record<string, unknown>
	const sourceType = record['sourceType']
	const params = normalizePackageWorkflowParams(
		record['params'] as PackageWorkflowParams | null | undefined,
	)
	if (sourceType === 'inline') {
		if (record['version'] !== 3) {
			throw new Error('Inline workflow payload version must be 3.')
		}
		const rawPackageContext = record['packageContext']
		if (
			rawPackageContext !== null &&
			(!rawPackageContext ||
				typeof rawPackageContext !== 'object' ||
				Array.isArray(rawPackageContext))
		) {
			throw new Error(
				'Inline workflow payload packageContext must be an object or null.',
			)
		}
		const packageContext = rawPackageContext
			? {
					packageId: normalizeNonEmptyString(
						String(
							(rawPackageContext as Record<string, unknown>)['packageId'] ?? '',
						),
						'packageContext.packageId',
					),
					kodyId: normalizeNonEmptyString(
						String(
							(rawPackageContext as Record<string, unknown>)['kodyId'] ?? '',
						),
						'packageContext.kodyId',
					),
					sourceId:
						typeof (rawPackageContext as Record<string, unknown>)[
							'sourceId'
						] === 'string'
							? String(
									(rawPackageContext as Record<string, unknown>)['sourceId'],
								)
							: null,
				}
			: null
		return createInlineWorkflowPayload({
			userId: String(record['userId'] ?? ''),
			packageContext,
			workflowName:
				typeof record['workflowName'] === 'string'
					? record['workflowName']
					: undefined,
			code: String(record['code'] ?? ''),
			idempotencyKey: String(record['idempotencyKey'] ?? ''),
			runAt: String(record['runAt'] ?? ''),
			params,
			planDate:
				typeof record['planDate'] === 'string' ? record['planDate'] : null,
		})
	}
	if (sourceType === 'package') {
		return createDynamicPackageWorkflowPayload({
			userId: String(record['userId'] ?? ''),
			packageId: String(record['packageId'] ?? ''),
			kodyId: String(record['kodyId'] ?? ''),
			sourceId: String(record['sourceId'] ?? ''),
			workflowName:
				typeof record['workflowName'] === 'string'
					? record['workflowName']
					: undefined,
			exportName: String(record['exportName'] ?? ''),
			idempotencyKey: String(record['idempotencyKey'] ?? ''),
			runAt: String(record['runAt'] ?? ''),
			params,
			planDate:
				typeof record['planDate'] === 'string' ? record['planDate'] : null,
		})
	}
	throw new Error('Dynamic callable workflow payload sourceType is invalid.')
}

async function readWorkflowInstanceSummary(
	instance: WorkflowInstance,
): Promise<{ id: string; status?: string }> {
	const status = await instance.status()
	return {
		id: instance.id,
		status: typeof status?.status === 'string' ? status.status : undefined,
	}
}

async function getExistingWorkflowInstance(
	workflow: Workflow<DynamicCallableWorkflowPayload>,
	id: string,
) {
	try {
		const instance = await workflow.get(id)
		return await readWorkflowInstanceSummary(instance)
	} catch (error) {
		if (isMissingWorkflowInstanceError(error)) {
			return null
		}
		throw error
	}
}

function isMissingWorkflowInstanceError(error: unknown) {
	if (!error || typeof error !== 'object') return false
	const workflowError = error as { code?: unknown; message?: unknown }
	if (workflowError.code === 404) return true
	const message =
		error instanceof Error
			? error.message
			: typeof workflowError.message === 'string'
				? workflowError.message
				: ''
	return /does not exist|not found|not_found|404/i.test(message)
}

function isDuplicateWorkflowInstanceError(error: unknown) {
	return (
		error instanceof Error &&
		/already exists|duplicate|conflict|409/i.test(error.message)
	)
}

function createWorkflowCreateResult(input: {
	summary: { id: string; status?: string }
	payload: DynamicCallableWorkflowPayload
}): PackageWorkflowCreateResult {
	return {
		ok: true,
		id: input.summary.id,
		workflow_name: input.payload.workflowName,
		source_type: input.payload.sourceType,
		package_id:
			input.payload.sourceType === 'package' ? input.payload.packageId : null,
		export_name:
			input.payload.sourceType === 'package' ? input.payload.exportName : null,
		run_at: input.payload.runAt,
		plan_date: input.payload.planDate,
		status: input.summary.status,
	}
}

function createWorkflowCreateResultFromRow(
	row: WorkflowRunInspection,
): PackageWorkflowCreateResult {
	return {
		ok: true,
		id: row.id,
		workflow_name: row.workflowName,
		source_type: row.sourceType,
		package_id: row.sourceType === 'package' ? row.packageId : null,
		export_name: row.sourceType === 'package' ? row.exportName : null,
		run_at: row.runAt,
		plan_date: row.planDate,
		...(row.status ? { status: row.status } : {}),
	}
}

async function findWorkflowRunByIdempotencyKey(input: {
	db: D1Database
	userId: string
	idempotencyKey: string
}): Promise<WorkflowRunInspection | null> {
	const trimmedKey = input.idempotencyKey.trim()
	if (!trimmedKey) return null
	const result = await input.db
		.prepare(
			`SELECT *
			FROM workflow_runs
			WHERE user_id = ? AND idempotency_key = ?
				AND COALESCE(status, '') != ?
			ORDER BY created_at ASC
			LIMIT 1`,
		)
		.bind(input.userId, trimmedKey, creatingWorkflowRunStatus)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapWorkflowRunRow(result)
}

async function createInlineWorkflowInstanceId(input: {
	userId: string
	workflowName: string
	idempotencyKey: string
	runAt: string | Date
	options?: {
		includeRunAt?: boolean
	}
}) {
	const canonical = canonicalJsonStringify({
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		sourceType: 'inline',
		workflowName: normalizeNonEmptyString(input.workflowName, 'workflowName'),
		idempotencyKey: normalizeNonEmptyString(
			input.idempotencyKey,
			'idempotencyKey',
		),
		...(input.options?.includeRunAt === false
			? {}
			: { runAt: normalizeRunAt(input.runAt) }),
	})
	return `dynwf-${(await sha256Base64Url(canonical)).slice(0, 43)}`
}

async function createDynamicCallableWorkflowInstanceId(
	payload: DynamicCallableWorkflowPayload,
	options?: {
		includeRunAt?: boolean
	},
) {
	if (payload.sourceType === 'package') {
		return await createPackageWorkflowInstanceId({ ...payload, options })
	}
	return await createInlineWorkflowInstanceId({ ...payload, options })
}

function mapWorkflowRunRow(
	row: Record<string, unknown>,
): WorkflowRunInspection {
	const rawSourceType = row['source_type']
	if (rawSourceType !== 'inline' && rawSourceType !== 'package') {
		throw new Error(`Unknown workflow source_type "${String(rawSourceType)}".`)
	}
	const rawStatus = row['status']
	const status =
		typeof rawStatus === 'string' && knownWorkflowStatuses.has(rawStatus)
			? (rawStatus as WorkflowRunStatus)
			: null
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		sourceType: rawSourceType,
		packageId: typeof row['package_id'] === 'string' ? row['package_id'] : null,
		kodyId: typeof row['kody_id'] === 'string' ? row['kody_id'] : null,
		sourceId: typeof row['source_id'] === 'string' ? row['source_id'] : null,
		workflowName: String(row['workflow_name']),
		exportName:
			typeof row['export_name'] === 'string' ? row['export_name'] : null,
		idempotencyKey: String(row['idempotency_key']),
		runAt: String(row['run_at']),
		planDate: typeof row['plan_date'] === 'string' ? row['plan_date'] : null,
		status,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
		completedAt:
			typeof row['completed_at'] === 'string' ? row['completed_at'] : null,
		lastError: typeof row['last_error'] === 'string' ? row['last_error'] : null,
	}
}

async function recordWorkflowRun(input: {
	db: D1Database
	id: string
	payload: DynamicCallableWorkflowPayload
	status: string | null
	now?: string
	lastError?: string | null
	completedAt?: string | null
}) {
	const now = input.now ?? new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO workflow_runs (
				id,
				user_id,
				source_type,
				package_id,
				kody_id,
				source_id,
				workflow_name,
				export_name,
				idempotency_key,
				run_at,
				plan_date,
				status,
				created_at,
				updated_at,
				completed_at,
				last_error
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				status = excluded.status,
				updated_at = excluded.updated_at,
				completed_at = COALESCE(excluded.completed_at, workflow_runs.completed_at),
				last_error = COALESCE(excluded.last_error, workflow_runs.last_error)`,
		)
		.bind(
			input.id,
			input.payload.userId,
			input.payload.sourceType,
			input.payload.sourceType === 'package' ? input.payload.packageId : null,
			input.payload.sourceType === 'package' ? input.payload.kodyId : null,
			input.payload.sourceType === 'package' ? input.payload.sourceId : null,
			input.payload.workflowName,
			input.payload.sourceType === 'package' ? input.payload.exportName : null,
			input.payload.idempotencyKey,
			input.payload.runAt,
			input.payload.planDate,
			input.status,
			now,
			now,
			input.completedAt ?? null,
			input.lastError ?? null,
		)
		.run()
}

async function updateWorkflowRunStatus(input: {
	env: Env
	id: string
	payload: DynamicCallableWorkflowPayload
	status: string
	lastError?: string | null
	completedAt?: string | null
}) {
	if (!input.env.APP_DB) return
	await recordWorkflowRun({
		db: input.env.APP_DB,
		id: input.id,
		payload: input.payload,
		status: input.status,
		lastError: input.lastError,
		completedAt: input.completedAt,
	})
}

function assertWorkflowCreateBodyShape(body: PackageWorkflowCreateInput): {
	code: string | null
	exportName: string | null
} {
	const record = body as PackageWorkflowCreateInput & Record<string, unknown>
	const code =
		typeof record.code === 'string' && record.code.trim() ? record.code : null
	const exportName =
		typeof record.exportName === 'string' && record.exportName.trim()
			? record.exportName
			: null
	if ((code ? 1 : 0) + (exportName ? 1 : 0) !== 1) {
		throw new Error(
			'workflows.create requires exactly one of exportName or code.',
		)
	}
	return { code, exportName }
}

async function resolveWorkflowPayload(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId?: string | null
	} | null
	body: PackageWorkflowCreateInput
}): Promise<DynamicCallableWorkflowPayload> {
	const body = input.body as PackageWorkflowCreateInput &
		Record<string, unknown>
	const { code, exportName } = assertWorkflowCreateBodyShape(input.body)
	if (code) {
		return createInlineWorkflowPayload({
			userId: input.userId,
			packageContext: input.packageContext,
			workflowName: input.body.workflowName,
			code,
			idempotencyKey: input.body.idempotencyKey,
			runAt: input.body.runAt,
			params: input.body.params,
		})
	}
	const packageIdOrKodyId =
		(typeof body.packageId === 'string' ? body.packageId.trim() : '') ||
		input.packageContext?.packageId?.trim()
	if (!packageIdOrKodyId) {
		throw new Error(
			'workflows.create requires packageId when exportName is used outside package runtime context.',
		)
	}
	const savedPackage =
		(await getSavedPackageById(input.env.APP_DB, {
			userId: input.userId,
			packageId: packageIdOrKodyId,
		})) ??
		(await getSavedPackageByKodyId(input.env.APP_DB, {
			userId: input.userId,
			kodyId: packageIdOrKodyId,
		}))
	if (!savedPackage) {
		throw new Error(
			`Package "${packageIdOrKodyId}" was not found or is not owned by the current user.`,
		)
	}
	return createDynamicPackageWorkflowPayload({
		userId: input.userId,
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		sourceId: savedPackage.sourceId,
		workflowName: input.body.workflowName,
		exportName: exportName ?? '',
		idempotencyKey: input.body.idempotencyKey,
		runAt: input.body.runAt,
		params: input.body.params,
	})
}

export async function createDynamicCallableWorkflow(input: {
	env: Pick<Env, 'APP_DB' | 'DYNAMIC_CALLABLE_WORKFLOWS'>
	userId: string
	userEmail?: string | null
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId?: string | null
	} | null
	body: PackageWorkflowCreateInput
}): Promise<PackageWorkflowCreateResult> {
	if (!input.env.DYNAMIC_CALLABLE_WORKFLOWS) {
		throw new Error('Missing DYNAMIC_CALLABLE_WORKFLOWS binding.')
	}
	assertWorkflowCreateBodyShape(input.body)
	const idempotencyKeyInput =
		typeof input.body.idempotencyKey === 'string'
			? input.body.idempotencyKey.trim()
			: ''
	if (input.env.APP_DB && idempotencyKeyInput) {
		const existingRun = await findWorkflowRunByIdempotencyKey({
			db: input.env.APP_DB,
			userId: input.userId,
			idempotencyKey: idempotencyKeyInput,
		})
		if (existingRun) {
			return createWorkflowCreateResultFromRow(existingRun)
		}
	}
	const payload = await resolveWorkflowPayload(input)
	const id = await createDynamicCallableWorkflowInstanceId(payload, {
		// An explicit idempotency key must single-flight even before the
		// workflow_runs projection row is written.
		includeRunAt: !idempotencyKeyInput,
	})
	const existing = await getExistingWorkflowInstance(
		input.env.DYNAMIC_CALLABLE_WORKFLOWS,
		id,
	)
	if (existing) {
		if (input.env.APP_DB) {
			await recordWorkflowRun({
				db: input.env.APP_DB,
				id,
				payload,
				status: existing.status ?? null,
			})
			if (idempotencyKeyInput) {
				const projectedRun = await findWorkflowRunByIdempotencyKey({
					db: input.env.APP_DB,
					userId: input.userId,
					idempotencyKey: idempotencyKeyInput,
				})
				if (projectedRun) return createWorkflowCreateResultFromRow(projectedRun)
			}
		}
		return createWorkflowCreateResult({ summary: existing, payload })
	}
	if (input.env.APP_DB) {
		await assertWithinEntitlement({
			db: input.env.APP_DB,
			userId: payload.userId,
			email: input.userEmail,
			resource: 'concurrent_workflows',
		})
	}
	if (input.env.APP_DB && idempotencyKeyInput) {
		await recordWorkflowRun({
			db: input.env.APP_DB,
			id,
			payload,
			status: creatingWorkflowRunStatus,
		})
	}
	let instance: WorkflowInstance
	try {
		instance = await input.env.DYNAMIC_CALLABLE_WORKFLOWS.create({
			id,
			params: payload,
			retention: {
				successRetention: '30 days',
				errorRetention: '30 days',
			},
		})
	} catch (error) {
		if (isDuplicateWorkflowInstanceError(error)) {
			const concurrent = await getExistingWorkflowInstance(
				input.env.DYNAMIC_CALLABLE_WORKFLOWS,
				id,
			)
			if (concurrent) {
				if (input.env.APP_DB) {
					await recordWorkflowRun({
						db: input.env.APP_DB,
						id,
						payload,
						status: concurrent.status ?? null,
					})
					if (idempotencyKeyInput) {
						const projectedRun = await findWorkflowRunByIdempotencyKey({
							db: input.env.APP_DB,
							userId: input.userId,
							idempotencyKey: idempotencyKeyInput,
						})
						if (projectedRun) {
							return createWorkflowCreateResultFromRow(projectedRun)
						}
					}
				}
				return createWorkflowCreateResult({
					summary: concurrent,
					payload,
				})
			}
		}
		throw error
	}
	if (input.env.APP_DB) {
		await recordWorkflowRun({
			db: input.env.APP_DB,
			id,
			payload,
			status: 'queued',
		})
	}
	const summary = await readWorkflowInstanceSummary(instance)
	if (input.env.APP_DB && summary.status) {
		await recordWorkflowRun({
			db: input.env.APP_DB,
			id,
			payload,
			status: summary.status,
		})
	}
	if (input.env.APP_DB && idempotencyKeyInput) {
		const projectedRun = await findWorkflowRunByIdempotencyKey({
			db: input.env.APP_DB,
			userId: input.userId,
			idempotencyKey: idempotencyKeyInput,
		})
		if (projectedRun) return createWorkflowCreateResultFromRow(projectedRun)
	}
	return createWorkflowCreateResult({ summary, payload })
}

export async function listWorkflowRunsForUser(input: {
	env: Pick<Env, 'APP_DB' | 'DYNAMIC_CALLABLE_WORKFLOWS'>
	userId: string
	limit?: number
}): Promise<Array<WorkflowRunInspection>> {
	const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
	const result = await input.env.APP_DB.prepare(
		`SELECT *
		FROM workflow_runs
		WHERE user_id = ?
		ORDER BY created_at DESC
		LIMIT ?`,
	)
		.bind(input.userId, limit)
		.all<Record<string, unknown>>()
	const rows = (result.results ?? []).map(mapWorkflowRunRow)
	const updateStatements: Array<D1PreparedStatement> = []
	const now = new Date()
	await Promise.all(
		rows.map(async (row) => {
			if (!input.env.DYNAMIC_CALLABLE_WORKFLOWS) return
			if (!row.status || !activeWorkflowStatuses.has(row.status)) return
			const updatedAtMs = new Date(row.updatedAt).getTime()
			if (
				Number.isFinite(updatedAtMs) &&
				now.getTime() - updatedAtMs < workflowStatusRefreshTtlMs
			) {
				return
			}
			let instance: WorkflowInstance
			try {
				instance = await input.env.DYNAMIC_CALLABLE_WORKFLOWS.get(row.id)
			} catch (error) {
				if (isMissingWorkflowInstanceError(error)) return
				throw error
			}
			const summary = await readWorkflowInstanceSummary(instance)
			if (!summary.status || !knownWorkflowStatuses.has(summary.status)) return
			if (summary.status === row.status) return
			row.status = summary.status as WorkflowRunStatus
			row.updatedAt = now.toISOString()
			if (terminalWorkflowStatuses.has(row.status) && !row.completedAt) {
				row.completedAt = row.updatedAt
			}
			updateStatements.push(
				input.env.APP_DB.prepare(
					`UPDATE workflow_runs
					SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at)
					WHERE id = ? AND user_id = ?`,
				).bind(
					row.status,
					row.updatedAt,
					row.completedAt,
					row.id,
					input.userId,
				),
			)
		}),
	)
	if (updateStatements.length > 0) {
		const dbWithBatch = input.env.APP_DB as D1Database & {
			batch?: D1Database['batch']
		}
		if (dbWithBatch.batch) {
			await dbWithBatch.batch(updateStatements)
		} else {
			await Promise.all(updateStatements.map((statement) => statement.run()))
		}
	}
	return rows
}

export class DynamicCallableWorkflowBase extends WorkflowEntrypoint<
	Env,
	DynamicCallableWorkflowPayload
> {
	async run(
		event: Readonly<WorkflowEvent<DynamicCallableWorkflowPayload>>,
		step: WorkflowStep,
	) {
		const payload = validateDynamicCallableWorkflowPayload(event.payload)
		applyDynamicWorkflowSentryScope({
			payload,
			instanceId: event.instanceId,
		})
		const runAt = new Date(payload.runAt)
		if (runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait until dynamic workflow runAt', runAt)
		}
		const typedStep = step as unknown as DynamicCallableWorkflowStep
		// Captured inside a step so replays after interruption reuse the original
		// start time. The clock starts after the scheduled runAt sleep so a
		// workflow queued days ahead does not record days of "runtime".
		const startedAtMs = Number(
			await typedStep.do(
				'capture usage start time',
				workflowStepDoConfig,
				async () => Date.now(),
			),
		)
		await typedStep.do(
			'mark workflow running',
			workflowStepDoConfig,
			async () => {
				await updateWorkflowRunStatus({
					env: this.env,
					id: event.instanceId,
					payload,
					status: 'running',
				})
				return { ok: true }
			},
		)
		let result: JsonValue
		try {
			result = await typedStep.do(
				payload.sourceType === 'package'
					? 'invoke saved package workflow export'
					: 'execute inline workflow code',
				workflowStepDoConfig,
				async () => {
					if (payload.sourceType === 'package') {
						return await this.invokePackageWorkflowExport(payload)
					}
					return await this.invokeInlineWorkflowCode(payload)
				},
			)
		} catch (error) {
			await updateWorkflowRunStatus({
				env: this.env,
				id: event.instanceId,
				payload,
				status: 'errored',
				lastError: getErrorMessage(error),
				completedAt: new Date().toISOString(),
			})
			await this.recordWorkflowRunUsage({
				typedStep,
				payload,
				instanceId: event.instanceId,
				startedAtMs,
				outcome: 'error',
			})
			throw error
		}
		// The catch above only wraps workflow execution: a failing terminal
		// status write must not relabel a successful run as an error.
		await updateWorkflowRunStatus({
			env: this.env,
			id: event.instanceId,
			payload,
			status: 'complete',
			completedAt: new Date().toISOString(),
		})
		await this.recordWorkflowRunUsage({
			typedStep,
			payload,
			instanceId: event.instanceId,
			startedAtMs,
			outcome: 'success',
		})
		return result
	}

	private async recordWorkflowRunUsage(input: {
		typedStep: DynamicCallableWorkflowStep
		payload: DynamicCallableWorkflowPayload
		instanceId: string
		startedAtMs: number
		outcome: 'success' | 'error'
	}) {
		if (!input.payload.userId) return
		// Emitted inside a step so a replayed run() returns the cached result
		// instead of recording the event again. The outcome is part of the step
		// name so cached results from one path can never shadow the other.
		await input.typedStep.do(
			`record workflow usage (${input.outcome})`,
			workflowStepDoConfig,
			async () => {
				await recordUsage(this.env, {
					userId: input.payload.userId,
					eventType: 'workflow_run',
					entityId: input.instanceId,
					durationMs: Date.now() - input.startedAtMs,
					outcome: input.outcome,
				})
				return { ok: true }
			},
		)
	}

	private async invokePackageWorkflowExport(
		payload: Extract<DynamicCallableWorkflowPayload, { sourceType: 'package' }>,
	): Promise<JsonValue> {
		const remoteConnectors = await listAttachedRemoteConnectorRefs({
			env: this.env,
			userId: payload.userId,
		})
		const response = await invokePackageExport({
			env: this.env,
			baseUrl: getAppBaseUrl({
				env: this.env,
			}),
			token: {
				tokenId: packageWorkflowTokenId,
				userId: payload.userId,
				email: '',
				displayName: `package:${payload.packageId}`,
				packageIds: [payload.packageId],
				packageKodyIds: [payload.kodyId],
				exportNames: [payload.exportName],
				sources: [packageWorkflowInvocationSource],
				remoteConnectors,
			},
			request: {
				packageIdOrKodyId: payload.packageId,
				exportName: payload.exportName,
				params: payload.params,
				idempotencyKey: payload.idempotencyKey,
				source: packageWorkflowInvocationSource,
				topic: payload.workflowName,
			},
		})
		if (response.status < 200 || response.status >= 300) {
			throw new Error(getWorkflowInvocationErrorMessage(response))
		}
		return {
			status: response.status,
			body: toJsonSafeValue(response.body),
		}
	}

	private async invokeInlineWorkflowCode(
		payload: Extract<DynamicCallableWorkflowPayload, { sourceType: 'inline' }>,
	): Promise<JsonValue> {
		if (payload.packageContext === undefined) {
			throw new Error(
				'Inline workflow payload is missing required package security context.',
			)
		}
		// This stays lazy because run-kody-registry imports package-workflows to
		// expose workflow helpers to executed modules.
		const { runModuleWithRegistry } = await import('#mcp/run-kody-registry.ts')
		const remoteConnectors = await listAttachedRemoteConnectorRefs({
			env: this.env,
			userId: payload.userId,
		})
		const result = await runModuleWithRegistry(
			this.env,
			createMcpCallerContext({
				baseUrl: getAppBaseUrl({
					env: this.env,
				}),
				executionOrigin: 'background',
				user: {
					userId: payload.userId,
					email: '',
					username: undefined,
					displayName: `workflow:${payload.workflowName}`,
				},
				storageContext: payload.packageContext
					? {
							sessionId: null,
							appId: payload.packageContext.packageId,
							packageId: payload.packageContext.packageId,
							storageId: null,
						}
					: null,
				remoteConnectors,
			}),
			payload.code,
			payload.params,
			{
				packageContext: payload.packageContext,
			},
		)
		if (result.error) {
			throw new Error(result.error)
		}
		return toJsonSafeValue(result.result) as JsonValue
	}
}

export const DynamicCallableWorkflow = Sentry.instrumentWorkflowWithSentry(
	(env: Env) => buildSentryOptions(env),
	DynamicCallableWorkflowBase,
)
