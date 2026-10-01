import { handleApiDocsRequest, type ApiDocsWorkerEnv } from './docs.ts'

export default {
	fetch(request, env) {
		return handleApiDocsRequest(request, env)
	},
} satisfies ExportedHandler<ApiDocsWorkerEnv>
