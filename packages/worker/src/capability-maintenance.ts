import { capabilitySpecs } from './mcp/capabilities/registry.ts'
import { handleSecretMaintenanceRequest } from './maintenance-handler.ts'
import { reindexCapabilityVectors } from './mcp/capabilities/capability-reindex.ts'

export async function handleCapabilityReindexRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'Capability reindex is not configured',
		run: () => reindexCapabilityVectors(env, capabilitySpecs),
	})
}
