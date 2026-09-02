import {
	handleSecretMaintenanceRequest,
	MaintenanceClientError,
	MaintenanceFailureError,
} from './maintenance-handler.ts'
import { getStaticRegistry } from './mcp/capabilities/registry.ts'
import { reindexCapabilityVectors } from './mcp/capabilities/capability-reindex.ts'
import { reindexJobVectors } from './jobs/job-reindex.ts'
import { reindexMemoryVectors } from './mcp/memory/memory-reindex.ts'
import { reindexSavedPackageVectors } from './package-registry/package-reindex.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	capabilityReindexPhases,
	capabilityReindexTimeBudgetMs,
	hasReachedReindexDeadline,
	isCapabilityReindexPhase,
	resolveCapabilityReindexPhases,
	type CapabilityReindexCursor,
	type CapabilityReindexPhase,
	type VectorReindexSweepResult,
} from '#worker/vectorize/reindex-sweep.ts'

type ReindexStepResult = VectorReindexSweepResult & {
	error?: string
}

type ReindexFailureSummary = {
	phase: string
	cause: string
	failed?: number
	failures?: ReindexStepResult['failures']
}

type CapabilityReindexKinds = {
	capabilities: ReindexStepResult
	memories: ReindexStepResult
	jobs: ReindexStepResult
	packages: ReindexStepResult
}

const skippedReindexStep: ReindexStepResult = {
	upserted: 0,
	complete: true,
	afterId: null,
}

async function runReindexStep(
	run: () => Promise<VectorReindexSweepResult>,
): Promise<ReindexStepResult> {
	try {
		return await run()
	} catch (error) {
		return {
			upserted: 0,
			complete: false,
			afterId: null,
			error: getErrorMessage(error),
		}
	}
}

function parseCapabilityReindexBody(body: unknown):
	| {
			ok: true
			cursor: CapabilityReindexCursor | null
			phases: ReadonlyArray<CapabilityReindexPhase>
			timeBudgetMs: number
			force: boolean
	  }
	| { ok: false; error: string } {
	if (body == null) {
		return {
			ok: true,
			cursor: null,
			phases: capabilityReindexPhases,
			timeBudgetMs: capabilityReindexTimeBudgetMs,
			force: false,
		}
	}
	if (typeof body !== 'object' || Array.isArray(body)) {
		return { ok: false, error: 'Reindex body must be a JSON object.' }
	}
	const record = body as Record<string, unknown>
	const phases = resolveCapabilityReindexPhases(record.phases)
	if (!phases.ok) {
		return phases
	}
	let force = false
	if (record.force !== undefined) {
		if (typeof record.force !== 'boolean') {
			return { ok: false, error: 'force must be a boolean.' }
		}
		force = record.force
	}
	let timeBudgetMs = capabilityReindexTimeBudgetMs
	if (record.timeBudgetMs !== undefined) {
		if (
			typeof record.timeBudgetMs !== 'number' ||
			!Number.isFinite(record.timeBudgetMs) ||
			record.timeBudgetMs < 0
		) {
			return {
				ok: false,
				error: 'timeBudgetMs must be a non-negative number.',
			}
		}
		timeBudgetMs = record.timeBudgetMs
	}
	if (record.cursor === undefined || record.cursor === null) {
		return {
			ok: true,
			cursor: null,
			phases: phases.phases,
			timeBudgetMs,
			force,
		}
	}
	if (typeof record.cursor !== 'object' || Array.isArray(record.cursor)) {
		return { ok: false, error: 'cursor must be an object.' }
	}
	const cursor = record.cursor as Record<string, unknown>
	if (!isCapabilityReindexPhase(cursor.phase)) {
		return {
			ok: false,
			error: 'cursor.phase must be capabilities, memories, jobs, or packages.',
		}
	}
	if (!phases.phases.includes(cursor.phase)) {
		return {
			ok: false,
			error: 'cursor.phase must be one of the requested phases.',
		}
	}
	if (cursor.afterId !== null && typeof cursor.afterId !== 'string') {
		return { ok: false, error: 'cursor.afterId must be a string or null.' }
	}
	return {
		ok: true,
		cursor: { phase: cursor.phase, afterId: cursor.afterId },
		phases: phases.phases,
		timeBudgetMs,
		force,
	}
}

async function runReindexPhase(
	env: Env,
	input: {
		baseUrl: string
		phase: CapabilityReindexPhase
		afterId: string | null
		deadlineMs: number
		force: boolean
	},
): Promise<ReindexStepResult> {
	switch (input.phase) {
		case 'capabilities':
			return runReindexStep(async () =>
				reindexCapabilityVectors(
					env,
					(await getStaticRegistry()).capabilitySpecs,
					{
						afterId: input.afterId,
						deadlineMs: input.deadlineMs,
						force: input.force,
					},
				),
			)
		case 'memories':
			return runReindexStep(() =>
				reindexMemoryVectors(env, {
					afterId: input.afterId,
					deadlineMs: input.deadlineMs,
					force: input.force,
				}),
			)
		case 'jobs':
			return runReindexStep(() =>
				reindexJobVectors(env, {
					afterId: input.afterId,
					deadlineMs: input.deadlineMs,
					force: input.force,
				}),
			)
		case 'packages':
			return runReindexStep(() =>
				reindexSavedPackageVectors(env, {
					baseUrl: input.baseUrl,
					afterId: input.afterId,
					deadlineMs: input.deadlineMs,
					force: input.force,
				}),
			)
		default: {
			const exhaustive: never = input.phase
			throw new Error(`Unexpected reindex phase: ${exhaustive}`)
		}
	}
}

async function reindexAllCapabilitySearchVectors(
	env: Env,
	input: {
		baseUrl: string
		cursor: CapabilityReindexCursor | null
		phases: ReadonlyArray<CapabilityReindexPhase>
		deadlineMs: number
		force: boolean
	},
) {
	const result: CapabilityReindexKinds = {
		capabilities: skippedReindexStep,
		memories: skippedReindexStep,
		jobs: skippedReindexStep,
		packages: skippedReindexStep,
	}
	const startPhase = input.cursor?.phase ?? input.phases[0]
	let afterId = input.cursor?.afterId ?? null
	let started = false

	for (const phase of input.phases) {
		if (!started) {
			if (phase !== startPhase) continue
			started = true
		} else if (hasReachedReindexDeadline(input.deadlineMs)) {
			return {
				...result,
				phases: input.phases,
				complete: false as const,
				cursor: { phase, afterId: null },
			}
		} else {
			afterId = null
		}

		const step = await runReindexPhase(env, {
			baseUrl: input.baseUrl,
			phase,
			afterId,
			deadlineMs: input.deadlineMs,
			force: input.force,
		})
		result[phase] = step
		if (step.error) continue
		if (!step.complete) {
			return {
				...result,
				phases: input.phases,
				complete: false as const,
				cursor: { phase, afterId: step.afterId },
			}
		}
	}

	return {
		...result,
		phases: input.phases,
		complete: true as const,
	}
}

export async function handleCapabilityReindexRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'Capability reindex is not configured',
		run: async () => {
			const body = await request.json().catch(() => null)
			const parsed = parseCapabilityReindexBody(body)
			if (!parsed.ok) {
				throw new MaintenanceClientError(parsed.error)
			}
			const result = await reindexAllCapabilitySearchVectors(env, {
				baseUrl: new URL(request.url).origin,
				cursor: parsed.cursor,
				phases: parsed.phases,
				deadlineMs: Date.now() + parsed.timeBudgetMs,
				force: parsed.force,
			})
			const kindResults = (
				['capabilities', 'memories', 'jobs', 'packages'] as const
			).map((phase) => [phase, result[phase]] as const)
			const failed = kindResults.filter(
				(
					entry,
				): entry is [
					CapabilityReindexPhase,
					ReindexStepResult & { error: string },
				] => typeof entry[1].error === 'string',
			)
			if (failed.length > 0) {
				const failedPhases: Array<ReindexFailureSummary> = failed.map(
					([phase, step]) => ({
						phase,
						cause: step.error,
						...(typeof step.failed === 'number' ? { failed: step.failed } : {}),
						...(step.failures ? { failures: step.failures } : {}),
					}),
				)
				throw new MaintenanceFailureError(
					`Capability search vector reindex failed for ${failed
						.map(([kind]) => kind)
						.join(', ')}: ${failed
						.map(([kind, step]) => `${kind}: ${step.error}`)
						.join('; ')}`,
					{
						...result,
						failure: {
							phase: 'reindex-capability-vectors',
							failedPhases,
						},
					},
				)
			}
			return result
		},
	})
}
