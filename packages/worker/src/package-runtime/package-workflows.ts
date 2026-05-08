import * as Sentry from '@sentry/cloudflare'
import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { invokePackageExport } from '#worker/package-invocations/service.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'

export type PackageWorkflowParams = Record<string, unknown>

type WorkflowCreateBaseInput = {
	workflowName?: string
	runAt: string | Date
	idempotencyKey: string
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

export type PackageWorkflowPayload = {
	version: 1
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

type WorkflowRunStatus =
	| 'queued'
	| 'running'
	| 'paused'
	| 'waiting'
	| 'waitingForPause'
	| 'unknown'
	| 'complete'
	| 'errored'
	| 'terminated'

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
			version: 2
			sourceType: 'inline'
			userId: string
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

type JsonValue =
	| null
	| boolean
	| number
	| string
	| Array<JsonValue>
	| { [key: string]: JsonValue }

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

const packageWorkflowTokenId = 'internal:package-workflows'
const maxPackageWorkflowParamsJsonBytes = 16 * 1024
const defaultConcurrentWorkflowLimit = 100
const workflowStatusRefreshTtlMs = 30_000
const activeWorkflowStatusValues = [
	'queued',
	'running',
	'paused',
	'waiting',
	'waitingForPause',
	'unknown',
] as const satisfies ReadonlyArray<WorkflowRunStatus>
const terminalWorkflowStatusValues = [
	'complete',
	'errored',
	'terminated',
] as const satisfies ReadonlyArray<WorkflowRunStatus>
const knownWorkflowStatusValues = [
	...activeWorkflowStatusValues,
	...terminalWorkflowStatusValues,
] as const
const activeWorkflowStatuses = new Set<string>(activeWorkflowStatusValues)
const terminalWorkflowStatuses = new Set<string>(terminalWorkflowStatusValues)
const knownWorkflowStatuses = new Set<string>(knownWorkflowStatusValues)

function toBase64Url(bytes: ArrayBuffer) {
	let binary = ''
	for (const byte of new Uint8Array(bytes)) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '')
}

async function sha256Base64Url(value: string) {
	return toBase64Url(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
	)
}

function canonicalizeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalizeJsonValue(entry))
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return Object.fromEntries(
			Object.keys(record)
				.sort((left, right) => left.localeCompare(right))
				.map((key) => [key, canonicalizeJsonValue(record[key])]),
		)
	}
	return value
}

function canonicalJsonStringify(value: unknown) {
	return JSON.stringify(canonicalizeJsonValue(value))
}

function toSerializableJson(value: unknown): JsonValue {
	try {
		return JSON.parse(JSON.stringify(value)) as JsonValue
	} catch {
		return value instanceof Error ? value.message : String(value)
	}
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

function normalizeRunAt(runAt: string | Date) {
	const date = typeof runAt === 'string' ? new Date(runAt) : runAt
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
}) {
	const canonical = canonicalJsonStringify({
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		packageId: normalizeNonEmptyString(input.packageId, 'packageId'),
		workflowName: normalizeNonEmptyString(input.workflowName, 'workflowName'),
		idempotencyKey: normalizeNonEmptyString(
			input.idempotencyKey,
			'idempotencyKey',
		),
		runAt: normalizeRunAt(input.runAt),
	})
	return `pkgwf-${(await sha256Base64Url(canonical)).slice(0, 43)}`
}

export function createPackageWorkflowPlanDate(runAt: string | Date) {
	return normalizeRunAt(runAt).slice(0, 'YYYY-MM-DD'.length)
}

export function createPackageWorkflowPayload(input: {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	workflowName: string
	exportName: string
	idempotencyKey: string
	runAt: string | Date
	params?: PackageWorkflowParams | null
	planDate?: string | null
}): PackageWorkflowPayload {
	const runAt = normalizeRunAt(input.runAt)
	const params = normalizePackageWorkflowParams(input.params)
	return {
		version: 1,
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		packageId: normalizeNonEmptyString(input.packageId, 'packageId'),
		kodyId: normalizeNonEmptyString(input.kodyId, 'kodyId'),
		sourceId: normalizeNonEmptyString(input.sourceId, 'sourceId'),
		workflowName: normalizeNonEmptyString(input.workflowName, 'workflowName'),
		exportName: normalizeWorkflowExportName(input.exportName),
		idempotencyKey: normalizeNonEmptyString(
			input.idempotencyKey,
			'idempotencyKey',
		),
		runAt,
		planDate: input.planDate?.trim() || createPackageWorkflowPlanDate(runAt),
		...(params === undefined ? {} : { params }),
	}
}

function createInlineWorkflowPayload(input: {
	userId: string
	workflowName?: string
	code: string
	idempotencyKey: string
	runAt: string | Date
	params?: PackageWorkflowParams | null
	planDate?: string | null
}): DynamicCallableWorkflowPayload {
	const runAt = normalizeRunAt(input.runAt)
	const params = normalizePackageWorkflowParams(input.params)
	return {
		version: 2,
		sourceType: 'inline',
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		workflowName: normalizeOptionalWorkflowName(
			input.workflowName,
			'inline-code',
		),
		code: normalizeNonEmptyString(input.code, 'code'),
		idempotencyKey: normalizeNonEmptyString(
			input.idempotencyKey,
			'idempotencyKey',
		),
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
	idempotencyKey: string
	runAt: string | Date
	params?: PackageWorkflowParams | null
	planDate?: string | null
}): DynamicCallableWorkflowPayload {
	const legacyPayload = createPackageWorkflowPayload({
		...input,
		workflowName: normalizeOptionalWorkflowName(
			input.workflowName,
			input.exportName,
		),
	})
	const { version: _version, ...payloadWithoutVersion } = legacyPayload
	return {
		version: 2,
		sourceType: 'package',
		...payloadWithoutVersion,
	}
}

function validatePackageWorkflowPayload(
	input: unknown,
): PackageWorkflowPayload {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new Error('Package workflow payload must be an object.')
	}
	const record = input as Record<string, unknown>
	const params = normalizePackageWorkflowParams(
		record['params'] as PackageWorkflowParams | null | undefined,
	)
	return createPackageWorkflowPayload({
		userId: String(record['userId'] ?? ''),
		packageId: String(record['packageId'] ?? ''),
		kodyId: String(record['kodyId'] ?? ''),
		sourceId: String(record['sourceId'] ?? ''),
		workflowName: String(record['workflowName'] ?? ''),
		exportName: String(record['exportName'] ?? ''),
		idempotencyKey: String(record['idempotencyKey'] ?? ''),
		runAt: String(record['runAt'] ?? ''),
		params,
		planDate:
			typeof record['planDate'] === 'string' ? record['planDate'] : null,
	})
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
		return createInlineWorkflowPayload({
			userId: String(record['userId'] ?? ''),
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
	const status = await instance.status().catch(() => null)
	return {
		id: instance.id,
		status: typeof status?.status === 'string' ? status.status : undefined,
	}
}

async function getExistingWorkflowInstance(
	workflow: Workflow<PackageWorkflowPayload>,
	id: string,
) {
	try {
		const instance = await workflow.get(id)
		return await readWorkflowInstanceSummary(instance)
	} catch (error) {
		if (
			error instanceof Error &&
			/does not exist|not found|not_found|404/i.test(error.message)
		) {
			return null
		}
		throw error
	}
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
			ORDER BY created_at ASC
			LIMIT 1`,
		)
		.bind(input.userId, trimmedKey)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapWorkflowRunRow(result)
}

async function createInlineWorkflowInstanceId(input: {
	userId: string
	workflowName: string
	idempotencyKey: string
	runAt: string | Date
}) {
	const canonical = canonicalJsonStringify({
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		sourceType: 'inline',
		workflowName: normalizeNonEmptyString(input.workflowName, 'workflowName'),
		idempotencyKey: normalizeNonEmptyString(
			input.idempotencyKey,
			'idempotencyKey',
		),
		runAt: normalizeRunAt(input.runAt),
	})
	return `dynwf-${(await sha256Base64Url(canonical)).slice(0, 43)}`
}

async function createDynamicCallableWorkflowInstanceId(
	payload: DynamicCallableWorkflowPayload,
) {
	if (payload.sourceType === 'package') {
		return await createPackageWorkflowInstanceId(payload)
	}
	return await createInlineWorkflowInstanceId(payload)
}

function getConcurrentWorkflowLimit(env: Env) {
	const raw = env.WORKFLOW_CONCURRENT_LIMIT
	if (typeof raw !== 'string') return defaultConcurrentWorkflowLimit
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: defaultConcurrentWorkflowLimit
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

async function countActiveWorkflowRuns(input: {
	db: D1Database
	userId: string
}) {
	const placeholders = activeWorkflowStatusValues.map(() => '?').join(', ')
	const result = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM workflow_runs
			WHERE user_id = ?
				AND status IN (${placeholders})`,
		)
		.bind(input.userId, ...activeWorkflowStatusValues)
		.first<{ count: number }>()
	return Number(result?.count ?? 0)
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
	const id = await createDynamicCallableWorkflowInstanceId(payload)
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
		}
		return createWorkflowCreateResult({ summary: existing, payload })
	}
	if (input.env.APP_DB) {
		const activeCount = await countActiveWorkflowRuns({
			db: input.env.APP_DB,
			userId: payload.userId,
		})
		const limit = getConcurrentWorkflowLimit(input.env as Env)
		if (activeCount >= limit) {
			throw new Error(
				`workflows.create would exceed the per-user concurrent workflow limit (${limit}). Wait for existing workflows to finish or cancel them before creating more.`,
			)
		}
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
				return createWorkflowCreateResult({
					summary: concurrent,
					payload,
				})
			}
		}
		throw error
	}
	const summary = await readWorkflowInstanceSummary(instance)
	if (input.env.APP_DB) {
		await recordWorkflowRun({
			db: input.env.APP_DB,
			id,
			payload,
			status: summary.status ?? 'queued',
		})
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
			const instance = await input.env.DYNAMIC_CALLABLE_WORKFLOWS.get(
				row.id,
			).catch(() => null)
			if (!instance) return
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
		const runAt = new Date(payload.runAt)
		if (runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait until dynamic workflow runAt', runAt)
		}
		const typedStep = step as unknown as {
			do(
				name: string,
				config: WorkflowStepDoConfig,
				callback: () => Promise<JsonValue>,
			): Promise<JsonValue>
		}
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
		try {
			const result = await typedStep.do(
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
			await updateWorkflowRunStatus({
				env: this.env,
				id: event.instanceId,
				payload,
				status: 'complete',
				completedAt: new Date().toISOString(),
			})
			return result
		} catch (error) {
			await updateWorkflowRunStatus({
				env: this.env,
				id: event.instanceId,
				payload,
				status: 'errored',
				lastError: error instanceof Error ? error.message : String(error),
				completedAt: new Date().toISOString(),
			})
			throw error
		}
	}

	private async invokePackageWorkflowExport(
		payload: Extract<DynamicCallableWorkflowPayload, { sourceType: 'package' }>,
	): Promise<JsonValue> {
		const response = await invokePackageExport({
			env: this.env,
			baseUrl: getAppBaseUrl({
				env: this.env,
				requestUrl: 'https://kody.invalid/',
			}),
			token: {
				tokenId: packageWorkflowTokenId,
				userId: payload.userId,
				email: '',
				displayName: `package:${payload.packageId}`,
				packageIds: [payload.packageId],
				packageKodyIds: [payload.kodyId],
				exportNames: [payload.exportName],
				sources: ['package-workflow'],
			},
			request: {
				packageIdOrKodyId: payload.packageId,
				exportName: payload.exportName,
				params: payload.params,
				idempotencyKey: payload.idempotencyKey,
				source: 'package-workflow',
				topic: payload.workflowName,
			},
		})
		return {
			status: response.status,
			body: toSerializableJson(response.body),
		}
	}

	private async invokeInlineWorkflowCode(
		payload: Extract<DynamicCallableWorkflowPayload, { sourceType: 'inline' }>,
	): Promise<JsonValue> {
		const [{ runModuleWithRegistry }, { createMcpCallerContext }] =
			await Promise.all([
				import('#mcp/run-codemode-registry.ts'),
				import('#mcp/context.ts'),
			])
		const result = await runModuleWithRegistry(
			this.env,
			createMcpCallerContext({
				baseUrl: getAppBaseUrl({
					env: this.env,
					requestUrl: 'https://kody.invalid/',
				}),
				user: {
					userId: payload.userId,
					email: '',
					displayName: `workflow:${payload.workflowName}`,
				},
			}),
			payload.code,
			payload.params,
		)
		if (result.error) {
			throw new Error(String(result.error))
		}
		return toSerializableJson(result.result) as JsonValue
	}
}

export class PackageWorkflowEntrypointBase extends WorkflowEntrypoint<
	Env,
	PackageWorkflowPayload
> {
	async run(
		event: Readonly<WorkflowEvent<PackageWorkflowPayload>>,
		step: WorkflowStep,
	) {
		const payload = validatePackageWorkflowPayload(event.payload)
		const runAt = new Date(payload.runAt)
		if (runAt.getTime() > Date.now()) {
			await step.sleepUntil('wait until package workflow runAt', runAt)
		}
		const invokePackageWorkflowExport = async (): Promise<JsonValue> => {
			const response = await invokePackageExport({
				env: this.env,
				baseUrl: getAppBaseUrl({
					env: this.env,
					requestUrl: 'https://kody.invalid/',
				}),
				token: {
					tokenId: packageWorkflowTokenId,
					userId: payload.userId,
					email: '',
					displayName: `package:${payload.packageId}`,
					packageIds: [payload.packageId],
					packageKodyIds: [payload.kodyId],
					exportNames: [payload.exportName],
					sources: ['package-workflow'],
				},
				request: {
					packageIdOrKodyId: payload.packageId,
					exportName: payload.exportName,
					params: payload.params,
					idempotencyKey: payload.idempotencyKey,
					source: 'package-workflow',
					topic: payload.workflowName,
				},
			})
			return {
				status: response.status,
				body: toSerializableJson(response.body),
			}
		}
		const typedStep = step as unknown as {
			do(
				name: string,
				config: WorkflowStepDoConfig,
				callback: () => Promise<JsonValue>,
			): Promise<JsonValue>
		}
		return await typedStep.do(
			'invoke saved package workflow export',
			workflowStepDoConfig,
			invokePackageWorkflowExport,
		)
	}
}

export const PackageWorkflowEntrypoint = Sentry.instrumentWorkflowWithSentry(
	(env: Env) => buildSentryOptions(env),
	PackageWorkflowEntrypointBase,
)

export const DynamicCallableWorkflow = Sentry.instrumentWorkflowWithSentry(
	(env: Env) => buildSentryOptions(env),
	DynamicCallableWorkflowBase,
)
