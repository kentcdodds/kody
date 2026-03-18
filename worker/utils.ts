export function withCors<Props>({
	getCorsHeaders,
	handler,
}: {
	getCorsHeaders(
		request: Request,
	): Record<string, string> | Headers | null | undefined
	handler: CustomExportedHandler<Props>['fetch']
}): CustomExportedHandler<Props>['fetch'] {
	return async (request, env, ctx) => {
		const corsHeaders = getCorsHeaders(request)
		if (!corsHeaders) {
			return handler(request, env, ctx)
		}

		// Handle CORS preflight requests
		if (request.method === 'OPTIONS') {
			const headers = mergeHeaders(corsHeaders, {
				'Access-Control-Max-Age': '86400',
			})

			return new Response(null, { status: 204, headers })
		}

		// Call the original handler
		const response = await handler(request, env, ctx)

		// WebSocket upgrade responses must be returned as-is or the upgrade breaks.
		if (response.status === 101) {
			return response
		}

		// Add CORS headers to ALL responses, including early returns
		const newHeaders = mergeHeaders(response.headers, corsHeaders)

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: newHeaders,
		})
	}
}

/**
 * Merge multiple headers objects into one (uses set so headers are overridden)
 */
export function mergeHeaders(
	...headers: Array<ResponseInit['headers'] | null | undefined>
) {
	const merged = new Headers()
	for (const header of headers) {
		if (!header) continue
		for (const [key, value] of new Headers(header).entries()) {
			merged.set(key, value)
		}
	}
	return merged
}

export function wantsJson(request: Request) {
	return request.headers.get('Accept')?.includes('application/json') ?? false
}
