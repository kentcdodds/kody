import { handleSecretMaintenanceRequest } from './maintenance-handler.ts'
import { reindexJobVectors } from './jobs/job-reindex.ts'

export async function handleJobReindexRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.JOB_REINDEX_SECRET,
		notConfiguredMessage: 'Job reindex is not configured',
		run: () => reindexJobVectors(env),
	})
}
