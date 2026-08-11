import * as Sentry from '@sentry/cloudflare'
import { type JobsWorkerEnv } from './env.ts'
import { JobManager } from './manager-do.ts'
import {
	dispatchScheduledLanes,
	handleScheduledDispatchQueue,
} from './scheduled.ts'
import { buildSentryOptions } from './sentry-options.ts'
import { JobsService } from './service.ts'

export { JobManager, JobsService }

const handler = {
	async fetch(request: Request, env: JobsWorkerEnv) {
		const url = new URL(request.url)
		if (url.pathname === '/health') {
			return Response.json(
				{ ok: true, commit: env.APP_COMMIT_SHA ?? null },
				{ headers: { 'Cache-Control': 'no-store' } },
			)
		}
		return new Response('Not found', { status: 404 })
	},
	async scheduled(
		controller: ScheduledController,
		env: JobsWorkerEnv,
		ctx: ExecutionContext,
	) {
		ctx.waitUntil(dispatchScheduledLanes({ controller, env }))
	},
	async queue(batch: MessageBatch<unknown>, env: JobsWorkerEnv) {
		await handleScheduledDispatchQueue(batch, env)
	},
} satisfies ExportedHandler<JobsWorkerEnv>

export default Sentry.withSentry(
	(env: JobsWorkerEnv) => buildSentryOptions(env),
	handler,
)
