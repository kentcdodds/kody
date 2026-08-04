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
		if (url.pathname === '/') {
			const snapshot = await getStore(env).getSnapshot()
			return new Response(renderStatusPage(snapshot), {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': 'public, max-age=30',
				},
			})
		}
		if (url.pathname === '/status.json') {
			const snapshot = await getStore(env).getSnapshot()
			return Response.json(snapshot, {
				headers: { 'Cache-Control': 'public, max-age=30' },
			})
		}
		return new Response('Not found', { status: 404 })
	},
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(getStore(env).runProbes())
	},
} satisfies ExportedHandler<StatusWorkerEnv>
