import { handleApiEdgeRequest, type ApiWorkerEnv } from './edge.ts'

export default {
	fetch(request, env) {
		return handleApiEdgeRequest(request, env)
	},
} satisfies ExportedHandler<ApiWorkerEnv>
