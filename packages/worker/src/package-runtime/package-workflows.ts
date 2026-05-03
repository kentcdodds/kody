import * as Sentry from '@sentry/cloudflare'
import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { invokePackageExport } from '#worker/package-invocations/service.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'

export type PackageWorkflowParams = Record<string, unknown>

export type PackageWorkflowCreateInput = {
	workflowName: string
	exportName: string
	runAt: string | Date
	idempotencyKey: string
	params?: PackageWorkflowParams
}

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
	export_name: string
	run_at: string
	plan_date: string | null
	status?: string
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

function normalizeWorkflowExportName(exportName: string) {
	const trimmed = normalizeNonEmptyString(exportName, 'exportName')
	if (trimmed === '.' || trimmed === './') return '.'
	return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
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
}) {
	const canonical = canonicalJsonStringify({
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		packageId: normalizeNonEmptyString(input.packageId, 'packageId'),
		workflowName: normalizeNonEmptyString(input.workflowName, 'workflowName'),
		idempotencyKey: normalizeNonEmptyString(
			input.idempotencyKey,
			'idempotencyKey',
		),
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

function createPackageWorkflowCreateResult(input: {
	summary: { id: string; status?: string }
	payload: PackageWorkflowPayload
}): PackageWorkflowCreateResult {
	return {
		ok: true,
		id: input.summary.id,
		workflow_name: input.payload.workflowName,
		export_name: input.payload.exportName,
		run_at: input.payload.runAt,
		plan_date: input.payload.planDate,
		status: input.summary.status,
	}
}

export async function createPackageWorkflowInstance(input: {
	workflow: Workflow<PackageWorkflowPayload> | undefined
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	workflowName: string
	exportName: string
	runAt: string | Date
	idempotencyKey: string
	params?: PackageWorkflowParams | null
	planDate?: string | null
}): Promise<PackageWorkflowCreateResult> {
	if (!input.workflow) {
		throw new Error('Missing PACKAGE_WORKFLOWS binding.')
	}
	const payload = createPackageWorkflowPayload(input)
	const id = await createPackageWorkflowInstanceId(payload)
	const existing = await getExistingWorkflowInstance(input.workflow, id)
	if (existing) {
		return createPackageWorkflowCreateResult({ summary: existing, payload })
	}
	let instance: WorkflowInstance
	try {
		instance = await input.workflow.create({
			id,
			params: payload,
			retention: {
				successRetention: '30 days',
				errorRetention: '30 days',
			},
		})
	} catch (error) {
		if (isDuplicateWorkflowInstanceError(error)) {
			const concurrent = await getExistingWorkflowInstance(input.workflow, id)
			if (concurrent) {
				return createPackageWorkflowCreateResult({
					summary: concurrent,
					payload,
				})
			}
		}
		throw error
	}
	const summary = await readWorkflowInstanceSummary(instance)
	return createPackageWorkflowCreateResult({ summary, payload })
}

export async function createPackageWorkflow(input: {
	env: Pick<Env, 'PACKAGE_WORKFLOWS'>
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	body: PackageWorkflowCreateInput
}) {
	return await createPackageWorkflowInstance({
		workflow: input.env.PACKAGE_WORKFLOWS,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
		sourceId: input.sourceId,
		workflowName: input.body.workflowName,
		exportName: input.body.exportName,
		runAt: input.body.runAt,
		idempotencyKey: input.body.idempotencyKey,
		params: input.body.params,
	})
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
		await step.sleepUntil(
			'wait until package workflow runAt',
			new Date(payload.runAt),
		)
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
