import * as Sentry from '@sentry/cloudflare'
import {
	appWorkerGuidePath,
	appWorkerHealthPath,
	buildAppWorkerHealth,
	type AppWorkerGuideBody,
} from '@kody-internal/shared/app-worker.ts'
import { getWorkerSentryOptions } from './sentry-options.ts'
import { handleRequest } from '#app/handler.ts'
import { getGuideById } from '#worker/guides/catalog.ts'

/**
 * Remix/content Worker entrypoint (script `kody-app`, deployed from
 * `packages/app-worker/wrangler.jsonc`).
 *
 * Owns the browser app, blog, guides, and static assets extracted from the
 * main `kody` Worker so those deploys do not reset Durable Objects hosted on
 * the MCP script. The main Worker forwards app-owned requests here over the
 * `APP_SURFACE` service binding. This script exports no Durable Object
 * classes; it binds the main and runtime workers' classes cross-script.
 */
function shouldApplyLongLivedAssetCaching(pathname: string, env: Env) {
	const commitSha = (env as { APP_COMMIT_SHA?: string }).APP_COMMIT_SHA?.trim()
	if (!commitSha) return false
	return (
		pathname === '/client-entry.js' ||
		pathname === '/styles.css' ||
		pathname.startsWith('/assets/')
	)
}

function guideIdFromPath(pathname: string) {
	const prefix = '/__app/guides/'
	if (!pathname.startsWith(prefix)) return null
	const encoded = pathname.slice(prefix.length)
	if (!encoded || encoded.includes('/')) return null
	try {
		return decodeURIComponent(encoded)
	} catch {
		return null
	}
}

function jsonResponse(body: unknown, status = 200) {
	return Response.json(body, {
		status,
		headers: { 'Cache-Control': 'no-store' },
	})
}

const appWorkerHandler = {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url)

		if (url.pathname === appWorkerHealthPath) {
			return Response.json(
				buildAppWorkerHealth({
					commitSha: (env as { APP_COMMIT_SHA?: string }).APP_COMMIT_SHA,
					cookieSecretConfigured: Boolean(env.COOKIE_SECRET?.trim()),
				}),
			)
		}

		const guideId = guideIdFromPath(url.pathname)
		if (guideId !== null) {
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				return jsonResponse({ error: 'Method not allowed.' }, 405)
			}
			const expectedPath = appWorkerGuidePath(guideId)
			if (url.pathname !== expectedPath) {
				return jsonResponse({ error: 'Unknown Kody guide.' }, 404)
			}
			const guide = getGuideById(guideId)
			if (!guide) {
				return jsonResponse({ error: 'Unknown Kody guide.' }, 404)
			}
			const body: AppWorkerGuideBody = {
				title: guide.title,
				body: guide.body,
			}
			if (request.method === 'HEAD') {
				return new Response(null, {
					status: 200,
					headers: { 'Cache-Control': 'no-store' },
				})
			}
			return jsonResponse(body)
		}

		if (env.ASSETS && (request.method === 'GET' || request.method === 'HEAD')) {
			const response = await env.ASSETS.fetch(request)
			if (response.status !== 404) {
				if (shouldApplyLongLivedAssetCaching(url.pathname, env)) {
					const headers = new Headers(response.headers)
					headers.set('Cache-Control', 'public, max-age=31536000, immutable')
					return new Response(response.body, {
						status: response.status,
						statusText: response.statusText,
						headers,
					})
				}
				return response
			}
		}

		return handleRequest(request, env)
	},
} satisfies ExportedHandler<Env>

export default Sentry.withSentry(
	(env: Env) => getWorkerSentryOptions(env),
	appWorkerHandler,
)
