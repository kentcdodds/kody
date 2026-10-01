import {
	assertAccountWritableDb,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { authenticateApiRequest } from './authenticate.ts'
import {
	buildOpenApiDocument,
	kodyApiVersion,
	resolveApiOperation,
} from './document.ts'
import { ApiError, apiErrorResponse, notFound, toApiError } from './errors.ts'
import {
	assertApiScope,
	assertNativeOperationEnabled,
	invokeApiOperation,
} from './invoke.ts'
import { apiOperationUsesQueryInputs, matchApiRoute } from './operations.ts'
import {
	mergeApiParams,
	readJsonBody,
	readQueryParams,
} from './request-params.ts'

export const openApiDocumentPath = '/openapi.json'

function json(body: unknown, init: ResponseInit = {}) {
	return Response.json(body ?? null, {
		...init,
		headers: { 'Cache-Control': 'no-store', ...init.headers },
	})
}

async function readOperationParams(input: {
	request: Request
	url: URL
	match: Extract<ReturnType<typeof matchApiRoute>, { kind: 'match' }>
	inputSchema: Record<string, unknown>
}) {
	if (apiOperationUsesQueryInputs(input.match.operation.method)) {
		return mergeApiParams(
			input.match.pathParams,
			readQueryParams(input.url.searchParams, input.inputSchema),
		)
	}
	const body = await readJsonBody(input.request)
	switch (body.kind) {
		case 'too_large':
			throw new ApiError({
				status: 413,
				code: 'payload_too_large',
				message: 'Request body is too large.',
			})
		case 'unsupported_media_type':
			throw new ApiError({
				status: 415,
				code: 'unsupported_media_type',
				message: 'Request body must be application/json.',
			})
		case 'ok':
			return mergeApiParams(input.match.pathParams, body.body)
		default: {
			const exhaustive: never = body
			throw new Error(`Unexpected body result: ${String(exhaustive)}`)
		}
	}
}

async function handleOperation(input: {
	request: Request
	url: URL
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
}) {
	const match = matchApiRoute(input.request.method, input.url.pathname)
	switch (match.kind) {
		case 'not_found':
			throw notFound(
				`No route for ${input.request.method} ${input.url.pathname}. See ${openApiDocumentPath}.`,
			)
		case 'method_not_allowed':
			throw new ApiError({
				status: 405,
				code: 'method_not_allowed',
				message: `Method ${input.request.method} is not allowed here.`,
				headers: { Allow: match.allow.join(', ') },
			})
		case 'match':
			break
		default: {
			const exhaustive: never = match
			throw new Error(`Unexpected route match: ${String(exhaustive)}`)
		}
	}
	const ctx = await authenticateApiRequest(input)
	const resolved = resolveApiOperation(
		match.operation,
		await getStaticRegistry(),
	)
	await assertNativeOperationEnabled(ctx, match.operation)
	assertApiScope(ctx, resolved.scope)
	const params = await readOperationParams({
		request: input.request,
		url: input.url,
		match,
		inputSchema: resolved.inputSchema,
	})
	const userId = ctx.callerContext.user.userId
	const run = () =>
		invokeApiOperation({
			operationId: match.operation.operationId,
			params,
			ctx,
		})
	const writes =
		!resolved.readOnly || resolved.scope?.endsWith(':write') === true
	if (!writes) {
		await assertAccountWritableDb(input.env.APP_DB, userId)
		return json(await run())
	}
	return json(
		await withAccountWriteLease({
			db: input.env.APP_DB,
			stableUserId: userId,
			holder: `api:${match.operation.operationId}`,
			env: input.env,
			write: run,
		}),
	)
}

/**
 * Serve `api.kody.codes`: `GET /openapi.json` and the `/v1` operations.
 * Called by the `KodyApi` entrypoint after the edge worker has applied
 * rate limits, header stripping, and size caps.
 */
export async function handleOpenApiRequest(input: {
	request: Request
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
}): Promise<Response> {
	const url = new URL(input.request.url)
	try {
		if (url.pathname === openApiDocumentPath) {
			if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
				throw new ApiError({
					status: 405,
					code: 'method_not_allowed',
					message: 'Use GET.',
					headers: { Allow: 'GET, HEAD' },
				})
			}
			return Response.json(
				await buildOpenApiDocument({ serverUrl: url.origin }),
				{ headers: { 'Cache-Control': 'public, max-age=300' } },
			)
		}
		if (url.pathname === '/' && input.request.method === 'GET') {
			return json({
				name: 'Kody API',
				version: kodyApiVersion,
				openapi: `${url.origin}${openApiDocumentPath}`,
			})
		}
		return await handleOperation({ ...input, url })
	} catch (error) {
		const apiError = toApiError(error)
		if (apiError.status >= 500 && !(error instanceof ApiError)) {
			console.error('open-api-request-failed', url.pathname, error)
		}
		return apiErrorResponse(apiError)
	}
}
