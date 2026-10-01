import { renderApiDocsPage } from './page.ts'

export const defaultOpenApiSpecUrl = 'https://api.kody.codes/openapi.json'
export const openApiProxyPath = '/openapi.json'

export type ApiDocsWorkerEnv = {
	OPENAPI_SPEC_URL?: string
	APP_COMMIT_SHA?: string
}

const allowedMethods = ['GET', 'HEAD'] as const

function withSecurityHeaders(response: Response) {
	const headers = new Headers(response.headers)
	headers.set('X-Content-Type-Options', 'nosniff')
	headers.set('Referrer-Policy', 'no-referrer')
	headers.delete('Set-Cookie')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

function methodNotAllowed() {
	return withSecurityHeaders(
		new Response('Method not allowed', {
			status: 405,
			headers: {
				Allow: allowedMethods.join(', '),
				'Cache-Control': 'no-store',
			},
		}),
	)
}

function notFound() {
	return withSecurityHeaders(
		new Response('Not found', {
			status: 404,
			headers: { 'Cache-Control': 'no-store' },
		}),
	)
}

async function proxyOpenApiSpec(
	request: Request,
	specUrl: string,
): Promise<Response> {
	let upstream: Response
	try {
		upstream = await fetch(specUrl, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			redirect: 'follow',
		})
	} catch (error) {
		console.error('api-docs-openapi-fetch-failed', error)
		return withSecurityHeaders(
			Response.json(
				{
					error: {
						code: 'upstream_unavailable',
						message: 'Could not fetch the live OpenAPI document.',
					},
				},
				{ status: 502, headers: { 'Cache-Control': 'no-store' } },
			),
		)
	}

	if (!upstream.ok) {
		console.error('api-docs-openapi-upstream-status', upstream.status)
		return withSecurityHeaders(
			Response.json(
				{
					error: {
						code: 'upstream_error',
						message: `OpenAPI upstream returned HTTP ${upstream.status}.`,
					},
				},
				{ status: 502, headers: { 'Cache-Control': 'no-store' } },
			),
		)
	}

	const body = request.method === 'HEAD' ? null : await upstream.arrayBuffer()
	const headers = new Headers()
	headers.set(
		'Content-Type',
		upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
	)
	headers.set(
		'Cache-Control',
		upstream.headers.get('Cache-Control') ?? 'public, max-age=60',
	)
	const etag = upstream.headers.get('ETag')
	if (etag) headers.set('ETag', etag)
	return withSecurityHeaders(
		new Response(body, { status: upstream.status, headers }),
	)
}

function docsHtmlResponse(method: string) {
	const html = renderApiDocsPage({
		title: 'Kody API Reference',
		specPath: openApiProxyPath,
	})
	return withSecurityHeaders(
		new Response(method === 'HEAD' ? null : html, {
			status: 200,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'public, max-age=60',
			},
		}),
	)
}

/**
 * Public docs surface for `api-docs.kody.codes`. Answers `/health`, serves the
 * Scalar shell at `/`, and proxies `/openapi.json` from the configured API.
 */
export async function handleApiDocsRequest(
	request: Request,
	env: ApiDocsWorkerEnv,
): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname === '/health') {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return methodNotAllowed()
		}
		return withSecurityHeaders(
			Response.json(
				{ ok: true, commit: env.APP_COMMIT_SHA ?? null },
				{ headers: { 'Cache-Control': 'no-store' } },
			),
		)
	}

	if (
		!allowedMethods.includes(request.method as (typeof allowedMethods)[number])
	) {
		return methodNotAllowed()
	}

	if (url.pathname === openApiProxyPath) {
		const specUrl = env.OPENAPI_SPEC_URL?.trim() || defaultOpenApiSpecUrl
		return proxyOpenApiSpec(request, specUrl)
	}

	if (url.pathname === '/' || url.pathname === '') {
		return docsHtmlResponse(request.method)
	}

	return notFound()
}
