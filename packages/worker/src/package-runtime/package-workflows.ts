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
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	readPreExecutionPackageInvocationInfrastructureCode,
	readRetryablePackageInvocationInfrastructureCode,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageExport } from '#worker/package-invocations/service.ts'
import { packageWorkflowInvocationSource } from './package-invocation-sources.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { listAttachedRemoteConnectorRefs } from '#worker/remote-connector/settings-service.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import {
	beginRunRecord,
	deleteWorkflowProjectionIfCreating,
	findWorkflowProjectionByIdempotencyKey,
	finishRunRecord,
	getWorkflowProjection,
	listWorkflowProjections,
	reserveWorkflowProjectionSlot,
	upsertWorkflowProjection,
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'
import {
	creatingWorkflowProjectionStatus,
	isWorkflowBindingName,
	type WorkflowBindingName,
} from '#worker/run-records/workflow-projection.ts'
import { UserCodeError } from '#worker/user-code-error.ts'
import {
	activeWorkflowStatusValues,
	terminalWorkflowStatusValues,
	type WorkflowRunStatus,
} from './workflow-statuses.ts'
import { applyDynamicWorkflowSentryScope } from './package-workflows-sentry.ts'

/** Persisted on every RunLog workflow projection for this binding. */
export const dynamicCallableWorkflowsBindingName =
	'DYNAMIC_CALLABLE_WORKFLOWS' satisfies WorkflowBindingName

function normalizeWorkflowBindingName(value: string | null | undefined) {
	const trimmed = value?.trim() || dynamicCallableWorkflowsBindingName
	if (!isWorkflowBindingName(trimmed)) {
		throw new Error(`Unsupported workflow binding name "${trimmed}".`)
	}
	return trimmed
}

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
	bindingName: WorkflowBindingName
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

function resolveWorkflowEngineBinding(
	env: Pick<Env, 'DYNAMIC_CALLABLE_WORKFLOWS'>,
	bindingName: WorkflowBindingName,
): Workflow<DynamicCallableWorkflowPayload> {
	switch (bindingName) {
		case 'DYNAMIC_CALLABLE_WORKFLOWS': {
			if (!env.DYNAMIC_CALLABLE_WORKFLOWS) {
				throw new Error('Missing DYNAMIC_CALLABLE_WORKFLOWS binding.')
			}
			return env.DYNAMIC_CALLABLE_WORKFLOWS
		}
		default: {
			const exhaustive: never = bindingName
			throw new Error(`Unsupported workflow binding: ${String(exhaustive)}`)
		}
	}
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

/**
 * Sandbox budget for workflow-invoked package exports / inline code.
 * Kept under the Cloudflare Workflow step timeout (`5 minutes`) so status
 * bookkeeping still has headroom after the sandbox returns.
 */
export const workflowExecutorTimeoutMs = 270_000

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

function readWorkflowInvocationErrorCode(response: {
	status: number
	body: unknown
}) {
	const body = response.body
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const error = (body as Record<string, unknown>)['error']
	if (!error || typeof error !== 'object' || Array.isArray(error)) return null
	const code = (error as Record<string, unknown>)['code']
	return typeof code === 'string' && code.trim() ? code : null
}

// Sandbox throws are HTTP 500 `execution_failed`; client mistakes are 4xx.
// Known infrastructure codes and other 5xx/unexpected statuses stay plain Errors.
function isPackageWorkflowUserCodeFailure(response: {
	status: number
	body: Record<string, unknown>
}) {
	if (readRetryablePackageInvocationInfrastructureCode(response)) return false
	if (readPreExecutionPackageInvocationInfrastructureCode(response)) {
		return false
	}
	if (readWorkflowInvocationErrorCode(response) === 'execution_failed') {
		return true
	}
	return response.status >= 400 && response.status < 500
}

function throwWorkflowInvocationFailure(response: {
	status: number
	body: Record<string, unknown>
}): never {
	const message = getWorkflowInvocationErrorMessage(response)
	if (isPackageWorkflowUserCodeFailure(response)) {
		throw new UserCodeError(message)
	}
	throw new Error(message)
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

function mapWorkflowProjectionToInspection(
	projection: WorkflowProjectionRecord,
	userId: string,
): WorkflowRunInspection {
	const rawStatus = projection.status
	const status =
		typeof rawStatus === 'string' && knownWorkflowStatuses.has(rawStatus)
			? (rawStatus as WorkflowRunStatus)
			: null
	return {
		id: projection.id,
		userId,
		bindingName: normalizeWorkflowBindingName(projection.bindingName),
		sourceType: projection.sourceType,
		packageId: projection.packageId,
		kodyId: projection.kodyId,
		sourceId: projection.sourceId,
		workflowName: projection.workflowName,
		exportName: projection.exportName,
		idempotencyKey: projection.idempotencyKey,
		runAt: projection.runAt,
		planDate: projection.planDate,
		status,
		createdAt: projection.createdAt,
		updatedAt: projection.updatedAt,
		completedAt: projection.completedAt,
		lastError: projection.lastError,
	}
}

/**
 * RunLog-only idempotency lookup (binding-scoped; excludes `creating`).
 */
export async function findWorkflowRunByIdempotencyKey(input: {
	env: Pick<Env, 'RUN_LOG'>
	userId: string
	idempotencyKey: string
	bindingName?: WorkflowBindingName
}): Promise<WorkflowRunInspection | null> {
	const trimmedKey = input.idempotencyKey.trim()
	if (!trimmedKey) return null
	const bindingName = input.bindingName ?? dynamicCallableWorkflowsBindingName
	const projection = await findWorkflowProjectionByIdempotencyKey({
		env: input.env as Env,
		userId: input.userId,
		idempotencyKey: trimmedKey,
		bindingName,
	})
	return projection
		? mapWorkflowProjectionToInspection(projection, input.userId)
		: null
}

async function getWorkflowRunForUser(input: {
	env: Pick<Env, 'RUN_LOG'>
	userId: string
	id: string
}): Promise<WorkflowRunInspection | null> {
	const projection = await getWorkflowProjection({
		env: input.env as Env,
		userId: input.userId,
		id: input.id,
	})
	return projection
		? mapWorkflowProjectionToInspection(projection, input.userId)
		: null
}

function buildWorkflowProjectionUpsert(input: {
	id: string
	payload: DynamicCallableWorkflowPayload
	status: string | null
	now?: string
	lastError?: string | null
	completedAt?: string | null
	createdAt?: string | null
}): WorkflowProjectionUpsertInput {
	const now = input.now ?? new Date().toISOString()
	return {
		id: input.id,
		bindingName: dynamicCallableWorkflowsBindingName,
		sourceType: input.payload.sourceType,
		packageId:
			input.payload.sourceType === 'package' ? input.payload.packageId : null,
		kodyId:
			input.payload.sourceType === 'package' ? input.payload.kodyId : null,
		sourceId:
			input.payload.sourceType === 'package' ? input.payload.sourceId : null,
		workflowName: input.payload.workflowName,
		exportName:
			input.payload.sourceType === 'package' ? input.payload.exportName : null,
		idempotencyKey: input.payload.idempotencyKey,
		runAt: input.payload.runAt,
		planDate: input.payload.planDate,
		status: input.status,
		createdAt: input.createdAt ?? now,
		updatedAt: now,
		completedAt: input.completedAt ?? null,
		lastError: input.lastError ?? null,
	}
}

function payloadFromWorkflowInspection(
	row: WorkflowRunInspection,
): DynamicCallableWorkflowPayload {
	if (row.sourceType === 'package') {
		return {
			version: 2,
			sourceType: 'package',
			userId: row.userId,
			packageId: row.packageId ?? '',
			kodyId: row.kodyId ?? '',
			sourceId: row.sourceId ?? '',
			workflowName: row.workflowName,
			exportName: row.exportName ?? '.',
			idempotencyKey: row.idempotencyKey,
			runAt: row.runAt,
			planDate: row.planDate,
		}
	}
	return {
		version: 3,
		sourceType: 'inline',
		userId: row.userId,
		packageContext: null,
		workflowName: row.workflowName,
		code: '',
		idempotencyKey: row.idempotencyKey,
		runAt: row.runAt,
		planDate: row.planDate,
	}
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

function isTerminalWorkflowStatus(status: string | null | undefined): boolean {
	return status != null && terminalWorkflowStatuses.has(status)
}

async function projectWorkflowRun(input: {
	env: Pick<Env, 'RUN_LOG'>
	userId: string
	id: string
	payload: DynamicCallableWorkflowPayload
	status: string | null
	now?: string
	lastError?: string | null
	completedAt?: string | null
	createdAt?: string | null
}) {
	const env = input.env as Env
	const existing = await getWorkflowProjection({
		env,
		userId: input.userId,
		id: input.id,
	})
	// Terminal stickiness: a later queued/running/creating write must not
	// regress cancelled/complete/errored/terminated projections.
	if (
		isTerminalWorkflowStatus(existing?.status) &&
		input.status != null &&
		!isTerminalWorkflowStatus(input.status)
	) {
		return
	}
	const projection = buildWorkflowProjectionUpsert({
		id: input.id,
		payload: input.payload,
		status: input.status,
		now: input.now,
		lastError: input.lastError,
		completedAt: input.completedAt,
		createdAt: input.createdAt ?? existing?.createdAt ?? null,
	})
	await upsertWorkflowProjection({
		env,
		userId: input.userId,
		projection,
	})
}

async function updateWorkflowRunStatus(input: {
	env: Pick<Env, 'RUN_LOG'>
	id: string
	payload: DynamicCallableWorkflowPayload
	status: string
	lastError?: string | null
	completedAt?: string | null
}) {
	await projectWorkflowRun({
		env: input.env,
		userId: input.payload.userId,
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
	env: Pick<Env, 'APP_DB' | 'DYNAMIC_CALLABLE_WORKFLOWS' | 'RUN_LOG'>
	userId: string
	userEmail?: string | null
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId?: string | null
	} | null
	body: PackageWorkflowCreateInput
}): Promise<PackageWorkflowCreateResult> {
	const env = input.env as Env
	const workflowBinding = resolveWorkflowEngineBinding(
		input.env,
		dynamicCallableWorkflowsBindingName,
	)
	assertWorkflowCreateBodyShape(input.body)
	const idempotencyKeyInput =
		typeof input.body.idempotencyKey === 'string'
			? input.body.idempotencyKey.trim()
			: ''
	if (idempotencyKeyInput) {
		const existingRun = await findWorkflowRunByIdempotencyKey({
			env,
			userId: input.userId,
			idempotencyKey: idempotencyKeyInput,
			bindingName: dynamicCallableWorkflowsBindingName,
		})
		if (existingRun) {
			return createWorkflowCreateResultFromRow(existingRun)
		}
	}
	const payload = await resolveWorkflowPayload(input)
	const id = await createDynamicCallableWorkflowInstanceId(payload, {
		// An explicit idempotency key must single-flight even before the
		// RunLog projection row is written.
		includeRunAt: !idempotencyKeyInput,
	})
	const existing = await getExistingWorkflowInstance(workflowBinding, id)
	if (existing) {
		await projectWorkflowRun({
			env,
			userId: input.userId,
			id,
			payload,
			status: existing.status ?? null,
		})
		if (idempotencyKeyInput) {
			const projectedRun = await findWorkflowRunByIdempotencyKey({
				env,
				userId: input.userId,
				idempotencyKey: idempotencyKeyInput,
				bindingName: dynamicCallableWorkflowsBindingName,
			})
			if (projectedRun) return createWorkflowCreateResultFromRow(projectedRun)
		}
		return createWorkflowCreateResult({ summary: existing, payload })
	}

	const reservationProjection = buildWorkflowProjectionUpsert({
		id,
		payload,
		status: creatingWorkflowProjectionStatus,
	})
	const reservation = await reserveWorkflowProjectionSlot({
		env,
		userId: input.userId,
		projection: reservationProjection,
	})
	if (!reservation.reserved) {
		// Insert-only reserve refused to clobber queued/running/terminal.
		return createWorkflowCreateResultFromRow(
			mapWorkflowProjectionToInspection(reservation.projection, input.userId),
		)
	}

	const releaseCreatingReservation = async () => {
		await deleteWorkflowProjectionIfCreating({
			env,
			userId: input.userId,
			id,
		})
	}

	// APP_DB remains for entitlement plan lookup only (not workflow projection).
	try {
		await assertWithinEntitlement({
			db: input.env.APP_DB,
			userId: payload.userId,
			email: input.userEmail,
			resource: 'concurrent_workflows',
			getCurrent: async () => reservation.countBeforeReservation,
		})
	} catch (error) {
		await releaseCreatingReservation()
		throw error
	}

	let instance: WorkflowInstance
	try {
		instance = await workflowBinding.create({
			id,
			params: payload,
			retention: {
				successRetention: '30 days',
				errorRetention: '30 days',
			},
		})
	} catch (error) {
		if (isDuplicateWorkflowInstanceError(error)) {
			const concurrent = await getExistingWorkflowInstance(workflowBinding, id)
			if (concurrent) {
				await projectWorkflowRun({
					env,
					userId: input.userId,
					id,
					payload,
					status: concurrent.status ?? null,
				})
				if (idempotencyKeyInput) {
					const projectedRun = await findWorkflowRunByIdempotencyKey({
						env,
						userId: input.userId,
						idempotencyKey: idempotencyKeyInput,
						bindingName: dynamicCallableWorkflowsBindingName,
					})
					if (projectedRun) {
						return createWorkflowCreateResultFromRow(projectedRun)
					}
				}
				return createWorkflowCreateResult({
					summary: concurrent,
					payload,
				})
			}
		}
		await releaseCreatingReservation()
		throw error
	}
	await projectWorkflowRun({
		env,
		userId: input.userId,
		id,
		payload,
		status: 'queued',
		createdAt: reservation.projection.createdAt,
	})
	const summary = await readWorkflowInstanceSummary(instance)
	if (summary.status) {
		await projectWorkflowRun({
			env,
			userId: input.userId,
			id,
			payload,
			status: summary.status,
			createdAt: reservation.projection.createdAt,
		})
	}
	if (idempotencyKeyInput) {
		const projectedRun = await findWorkflowRunByIdempotencyKey({
			env,
			userId: input.userId,
			idempotencyKey: idempotencyKeyInput,
			bindingName: dynamicCallableWorkflowsBindingName,
		})
		if (projectedRun) return createWorkflowCreateResultFromRow(projectedRun)
	}
	return createWorkflowCreateResult({ summary, payload })
}

export type CancelWorkflowRunResult =
	| { outcome: 'not_found' }
	| { outcome: 'already_terminal'; run: WorkflowRunInspection }
	| { outcome: 'cancelled'; run: WorkflowRunInspection }

export async function cancelWorkflowRunForUser(input: {
	env: Pick<Env, 'DYNAMIC_CALLABLE_WORKFLOWS' | 'RUN_LOG'>
	userId: string
	workflowRunId: string
}): Promise<CancelWorkflowRunResult> {
	const env = input.env as Env
	const workflowRunId = normalizeNonEmptyString(
		input.workflowRunId,
		'workflowRunId',
	)
	// USER-ISOLATION BOUNDARY: never touch the workflow binding before this
	// ownership check passes. RunLog is keyed by userId.
	const owned = await getWorkflowRunForUser({
		env,
		userId: input.userId,
		id: workflowRunId,
	})
	if (!owned) {
		return { outcome: 'not_found' }
	}
	const row = owned
	if (row.status !== null && terminalWorkflowStatuses.has(row.status)) {
		return { outcome: 'already_terminal', run: row }
	}
	const workflowBinding = resolveWorkflowEngineBinding(env, row.bindingName)
	let instance: WorkflowInstance | null = null
	try {
		instance = await workflowBinding.get(row.id)
	} catch (error) {
		if (!isMissingWorkflowInstanceError(error)) {
			throw error
		}
	}
	if (instance) {
		try {
			// Terminate before projecting cancelled: if the run finishes first,
			// terminate throws instead of stamping cancelled over a finished run.
			await instance.terminate()
		} catch (error) {
			// Per Cloudflare WorkflowInstance.terminate (worker-configuration.d.ts):
			// "Terminate the instance. If it is errored, terminated or complete, an
			// error will be thrown." — that contract makes catch-and-reread correct.
			let statusResult: { status?: string } | null = null
			try {
				statusResult = await instance.status()
			} catch {
				throw error
			}
			const engineStatus =
				typeof statusResult?.status === 'string' ? statusResult.status : null
			if (engineStatus && terminalWorkflowStatuses.has(engineStatus)) {
				const now = new Date().toISOString()
				const payload = payloadFromWorkflowInspection(row)
				await projectWorkflowRun({
					env,
					userId: input.userId,
					id: row.id,
					payload,
					status: engineStatus,
					now,
					completedAt: row.completedAt ?? now,
					createdAt: row.createdAt,
				})
				return {
					outcome: 'already_terminal',
					run: {
						...row,
						status: engineStatus as WorkflowRunStatus,
						updatedAt: now,
						completedAt: row.completedAt ?? now,
					},
				}
			}
			throw error
		}
	} else {
		// Missing engine instance: re-read before deciding. A concurrent create
		// may still own a `creating` reservation; reporting cancelled here would
		// let that create overtake with queued/running.
		const latestMissing = await getWorkflowProjection({
			env,
			userId: input.userId,
			id: row.id,
		})
		if (!latestMissing) {
			throw new Error(
				`Workflow run "${row.id}" disappeared while cancelling for the current user.`,
			)
		}
		// `creating` is not a Cloudflare WorkflowRunStatus, so inspection mapping
		// nulls it — check the raw projection before mapping.
		if (latestMissing.status === creatingWorkflowProjectionStatus) {
			// Same shape as package-invocation `invocation_in_progress` (retryable).
			throw new Error(
				`Workflow run "${row.id}" is still being created; retry cancellation shortly.`,
			)
		}
		const latestMissingRun = mapWorkflowProjectionToInspection(
			latestMissing,
			input.userId,
		)
		if (
			latestMissingRun.status !== null &&
			terminalWorkflowStatuses.has(latestMissingRun.status)
		) {
			return { outcome: 'already_terminal', run: latestMissingRun }
		}
		// Non-creating active/unknown with no engine instance (retention expiry):
		// nothing can fire, so projecting cancelled below is safe.
	}
	const now = new Date().toISOString()
	// Guard against stamping cancelled over a concurrent terminal projection
	// write (complete/errored/…) that landed while terminate still succeeded —
	// the engine can still report running when the workflow's own terminal step
	// write has already finished. Re-read decides the winner before/after the
	// cancelled upsert. An active straggler (`mark workflow running`) that lands
	// after a successful cancelled projection can still flip the row back; the
	// next listWorkflowRunsForUser refresh then projects engine `terminated`.
	const beforeCancel = await getWorkflowProjection({
		env,
		userId: input.userId,
		id: row.id,
	})
	if (!beforeCancel) {
		throw new Error(
			`Workflow run "${row.id}" disappeared while cancelling for the current user.`,
		)
	}
	const beforeCancelRun = mapWorkflowProjectionToInspection(
		beforeCancel,
		input.userId,
	)
	if (
		beforeCancelRun.status !== null &&
		terminalWorkflowStatuses.has(beforeCancelRun.status)
	) {
		return { outcome: 'already_terminal', run: beforeCancelRun }
	}
	const payload = payloadFromWorkflowInspection(beforeCancelRun)
	await projectWorkflowRun({
		env,
		userId: input.userId,
		id: row.id,
		payload,
		status: 'cancelled',
		now,
		completedAt: beforeCancelRun.completedAt ?? now,
		createdAt: beforeCancelRun.createdAt,
	})
	const projected = await getWorkflowProjection({
		env,
		userId: input.userId,
		id: row.id,
	})
	if (!projected) {
		throw new Error(
			`Workflow run "${row.id}" disappeared while cancelling for the current user.`,
		)
	}
	const projectedRun = mapWorkflowProjectionToInspection(
		projected,
		input.userId,
	)
	if (projectedRun.status === 'cancelled') {
		return { outcome: 'cancelled', run: projectedRun }
	}
	if (
		projectedRun.status !== null &&
		terminalWorkflowStatuses.has(projectedRun.status)
	) {
		return { outcome: 'already_terminal', run: projectedRun }
	}
	// An active straggler write (for example `mark workflow running`) landed
	// between the cancelled upsert and the re-read. The terminate already
	// succeeded (or the instance was missing), so the cancellation itself
	// worked; report the effective cancelled status to the caller while the
	// row self-heals to the engine's terminal status on the next
	// listWorkflowRunsForUser refresh.
	return { outcome: 'cancelled', run: { ...projectedRun, status: 'cancelled' } }
}

export async function listWorkflowRunsForUser(input: {
	env: Pick<Env, 'DYNAMIC_CALLABLE_WORKFLOWS' | 'RUN_LOG'>
	userId: string
	limit?: number
}): Promise<Array<WorkflowRunInspection>> {
	const env = input.env as Env
	const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
	const listed = await listWorkflowProjections({
		env,
		userId: input.userId,
		limit,
		bindingName: dynamicCallableWorkflowsBindingName,
	})
	const rows = listed.projections.map((projection) =>
		mapWorkflowProjectionToInspection(projection, input.userId),
	)
	const now = new Date()
	await Promise.all(
		rows.map(async (row) => {
			if (!row.status || !activeWorkflowStatuses.has(row.status)) return
			const updatedAtMs = new Date(row.updatedAt).getTime()
			if (
				Number.isFinite(updatedAtMs) &&
				now.getTime() - updatedAtMs < workflowStatusRefreshTtlMs
			) {
				return
			}
			const workflowBinding = resolveWorkflowEngineBinding(env, row.bindingName)
			let instance: WorkflowInstance
			try {
				instance = await workflowBinding.get(row.id)
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
			const payload = payloadFromWorkflowInspection(row)
			await projectWorkflowRun({
				env,
				userId: input.userId,
				id: row.id,
				payload,
				status: row.status,
				now: row.updatedAt,
				completedAt: row.completedAt,
				createdAt: row.createdAt,
			})
		}),
	)
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
						return await this.invokePackageWorkflowExport(
							payload,
							event.instanceId,
						)
					}
					return await this.invokeInlineWorkflowCode(payload, event.instanceId)
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
		instanceId: string,
	): Promise<JsonValue> {
		const runHandle = beginRunRecord({
			env: this.env,
			userId: payload.userId,
			context: {
				surface: 'workflow',
				name: payload.workflowName,
				packageId: payload.packageId,
				kodyId: payload.kodyId,
				sourceId: payload.sourceId,
				workflowId: instanceId,
				idempotencyKey: payload.idempotencyKey,
				metadata: {
					sourceType: 'package',
					exportName: payload.exportName,
				},
			},
			waitUntil: (promise) => {
				this.ctx.waitUntil(promise)
			},
		})
		try {
			const remoteConnectors = await listAttachedRemoteConnectorRefs({
				env: this.env,
				userId: payload.userId,
			})
			// Ephemeral + raised timeout: Workflow step.do already caches
			// successful results. Keyed invoke would replay a sandbox timeout
			// on retry (~ms) instead of re-executing; the default 90s export
			// cap is also below the 5-minute step window.
			const response = await invokePackageExport({
				env: this.env,
				baseUrl: getAppBaseUrl({
					env: this.env,
				}),
				token: {
					tokenId: packageWorkflowTokenId,
					userId: payload.userId,
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
					idempotencyKey: null,
					source: packageWorkflowInvocationSource,
					topic: payload.workflowName,
				},
				ephemeral: true,
				executorTimeoutMs: workflowExecutorTimeoutMs,
			})
			if (response.status < 200 || response.status >= 300) {
				throwWorkflowInvocationFailure(response)
			}
			const result = {
				status: response.status,
				body: toJsonSafeValue(response.body),
			}
			await finishRunRecord({
				env: this.env,
				handle: runHandle,
				status: 'success',
			})
			return result
		} catch (error) {
			await finishRunRecord({
				env: this.env,
				handle: runHandle,
				status: 'error',
				error,
			})
			throw error
		}
	}

	private async invokeInlineWorkflowCode(
		payload: Extract<DynamicCallableWorkflowPayload, { sourceType: 'inline' }>,
		instanceId: string,
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
		const runHandle = beginRunRecord({
			env: this.env,
			userId: payload.userId,
			context: {
				surface: 'workflow',
				name: payload.workflowName,
				workflowId: instanceId,
				storageId: null,
				idempotencyKey: payload.idempotencyKey,
				metadata: {
					sourceType: 'inline',
				},
			},
			waitUntil: (promise) => {
				this.ctx.waitUntil(promise)
			},
		})
		let logs: Array<string> | undefined
		try {
			const result = await runModuleWithRegistry(
				this.env,
				createMcpCallerContext({
					baseUrl: getAppBaseUrl({
						env: this.env,
					}),
					executionOrigin: 'background',
					user: await resolveBackgroundMcpUser(this.env.APP_DB, payload.userId),
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
					executorTimeoutMs: workflowExecutorTimeoutMs,
				},
			)
			logs = result.logs
			if (result.error) {
				throw new UserCodeError(result.error)
			}
			await finishRunRecord({
				env: this.env,
				handle: runHandle,
				status: 'success',
				logs,
			})
			return toJsonSafeValue(result.result) as JsonValue
		} catch (error) {
			await finishRunRecord({
				env: this.env,
				handle: runHandle,
				status: 'error',
				logs,
				error,
			})
			throw error
		}
	}
}

export const DynamicCallableWorkflow = Sentry.instrumentWorkflowWithSentry(
	(env: Env) => buildSentryOptions(env),
	DynamicCallableWorkflowBase,
)
