import { capabilitySpecs } from './mcp/capabilities/registry.ts'
import {
	handleSecretMaintenanceRequest,
	MaintenanceFailureError,
} from './maintenance-handler.ts'
import { reindexCapabilityVectors } from './mcp/capabilities/capability-reindex.ts'
import { reindexJobVectors } from './jobs/job-reindex.ts'
import { reindexMemoryVectors } from './mcp/memory/memory-reindex.ts'
import { reindexSavedPackageVectors } from './package-registry/package-reindex.ts'
import { getErrorMessage } from './mcp/capabilities/error-message.ts'

type ReindexStepResult = {
	upserted: number
	error?: string
	failed?: number
	warning?: string
	failures?: Array<{
		id: string
		phase: string
		error: string
	}>
}

type ReindexFailureSummary = {
	phase: string
	cause: string
	failed?: number
	failures?: ReindexStepResult['failures']
}

async function runReindexStep(
	run: () => Promise<ReindexStepResult>,
): Promise<ReindexStepResult> {
	try {
		return await run()
	} catch (error) {
		return {
			upserted: 0,
			error: getErrorMessage(error),
		}
	}
}

async function reindexAllCapabilitySearchVectors(
	env: Env,
	input: { baseUrl: string },
) {
	const capabilities = await runReindexStep(() =>
		reindexCapabilityVectors(env, capabilitySpecs),
	)
	const memories = await runReindexStep(() => reindexMemoryVectors(env))
	const jobs = await runReindexStep(() => reindexJobVectors(env))
	const packages = await runReindexStep(() =>
		reindexSavedPackageVectors(env, { baseUrl: input.baseUrl }),
	)
	return {
		capabilities,
		memories,
		jobs,
		packages,
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
			const result = await reindexAllCapabilitySearchVectors(env, {
				baseUrl: new URL(request.url).origin,
			})
			const failed = Object.entries(result).filter(
				(entry): entry is [string, ReindexStepResult & { error: string }] =>
					typeof entry[1].error === 'string',
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
