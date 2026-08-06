import { renderStatusPage } from './status-page.ts'
import { StatusStore, type StatusWorkerEnv } from './status-store.ts'

export { StatusStore }

function getStore(env: StatusWorkerEnv) {
	return env.STATUS_STORE.get(env.STATUS_STORE.idFromName('singleton'))
}

export default {
	async fetch(request, env) {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', { status: 405 })
		}
		const url = new URL(request.url)
		if (url.pathname === '/health') {
			return Response.json(
				{ ok: true, commit: env.BUILD_COMMIT ?? null },
				{ headers: { 'Cache-Control': 'no-store' } },
			)
		}
		if (url.pathname === '/' || url.pathname === '/status.json') {
			// The page must degrade gracefully even when its own Durable Object
			// is unavailable; a controlled 503 beats an uncaught error page.
			let snapshot
			try {
				snapshot = await getStore(env).getSnapshot()
			} catch (error) {
				console.warn(
					'status-snapshot-failed',
					error instanceof Error ? error.message : String(error),
				)
				const body = { error: 'Status data is temporarily unavailable.' }
				if (url.pathname === '/status.json') {
					return Response.json(body, {
						status: 503,
						headers: { 'Cache-Control': 'no-store' },
					})
				}
				return new Response(
					`<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta http-equiv="refresh" content="30" /><title>kody status</title></head><body><main><h1>kody status</h1><p>${body.error} This page retries automatically.</p></main></body></html>`,
					{
						status: 503,
						headers: {
							'Content-Type': 'text/html; charset=utf-8',
							'Cache-Control': 'no-store',
						},
					},
				)
			}
			if (url.pathname === '/status.json') {
				return Response.json(snapshot, {
					headers: { 'Cache-Control': 'public, max-age=30' },
				})
			}
			return new Response(renderStatusPage(snapshot), {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': 'public, max-age=30',
				},
			})
		}
		return new Response('Not found', { status: 404 })
	},
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(getStore(env).runProbes())
	},
} satisfies ExportedHandler<StatusWorkerEnv>
