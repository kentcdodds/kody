import { handleSecretMaintenanceRequest } from './maintenance-handler.ts'
import { reindexMemoryVectors } from './mcp/memory/memory-reindex.ts'

export async function handleMemoryReindexRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'Memory reindex is not configured',
		run: () => reindexMemoryVectors(env),
	})
}
