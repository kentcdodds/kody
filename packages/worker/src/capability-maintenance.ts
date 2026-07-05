import { capabilitySpecs } from './mcp/capabilities/registry.ts'
import { handleSecretMaintenanceRequest } from './maintenance-handler.ts'
import { reindexCapabilityVectors } from './mcp/capabilities/capability-reindex.ts'
import { reindexJobVectors } from './jobs/job-reindex.ts'
import { reindexMemoryVectors } from './mcp/memory/memory-reindex.ts'
import { reindexSavedPackageVectors } from './package-registry/package-reindex.ts'

async function reindexAllCapabilitySearchVectors(env: Env) {
	const capabilities = await reindexCapabilityVectors(env, capabilitySpecs)
	const memories = await reindexMemoryVectors(env)
	const jobs = await reindexJobVectors(env)
	const packages = await reindexSavedPackageVectors(env)
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
		run: () => reindexAllCapabilitySearchVectors(env),
	})
}
