import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import {
	invokePackageExport,
	type PackageInvocationTokenScope,
} from './service.ts'
import {
	getActivePackageInvocationTokenByHash,
	hashPackageInvocationBearerToken,
	updatePackageInvocationTokenLastUsed,
} from './repo.ts'

const packageInvocationPathPrefix = '/api/package-invocations/'

type PackageInvocationRequestBody = {
	params?: Record<string, unknown>
	idempotencyKey?: string
	source?: string | null
	topic?: string | null
}

function jsonResponse(data: unknown, init?: ResponseInit) {
	const headers = new Headers(init?.headers)
	headers.set('Content-Type', 'application/json')
	headers.set('Cache-Control', 'no-store')
	return new Response(JSON.stringify(data), {
		...init,
		headers,
	})
}

function buildAuthenticateHeader() {
	return 'Bearer realm="package-invocations"'
}

function unauthorizedResponse(message = 'Unauthorized') {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'unauthorized',
				message,
			},
		},
		{
			status: 401,
			headers: {
				'WWW-Authenticate': buildAuthenticateHeader(),
			},
		},
	)
}

function notFoundResponse() {
	return jsonResponse(
		{
			ok: false,
			error: {
				code: 'not_found',
				message: 'Not found.',
			},
		},
		{ status: 404 },
	)
}

function readBearerToken(request: Request) {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return null
	}
	const token = authHeader.slice('Bearer '.length).trim()
	return token.length > 0 ? token : null
}

function decodePathComponent(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function parsePackageInvocationPath(pathname: string) {
	if (!pathname.startsWith(packageInvocationPathPrefix)) {
		return null
	}
	const rest = pathname.slice(packageInvocationPathPrefix.length)
	const parts = rest.split('/')
	if (parts.length !== 2) {
		return null
	}
	const [packageIdOrKodyId, exportName] = parts.map((entry) =>
		decodePathComponent(entry),
	)
	if (!packageIdOrKodyId || !exportName) {
		return null
	}
	return { packageIdOrKodyId, exportName }
}

async function resolveTokenScope(input: {
	env: Env
	bearerToken: string
}): Promise<PackageInvocationTokenScope | null> {
	const tokenHash = await hashPackageInvocationBearerToken(input.bearerToken)
	const record = await getActivePackageInvocationTokenByHash({
		db: input.env.APP_DB,
		tokenHash,
	})
	if (!record) return null
	await updatePackageInvocationTokenLastUsed({
		db: input.env.APP_DB,
		id: record.id,
	})
	return {
		tokenId: record.id,
		userId: record.user_id,
		email: record.email,
		displayName: record.display_name,
		packageIds: record.packageIds,
		packageKodyIds: record.packageKodyIds,
		exportNames: record.exportNames,
		sources: record.sources,
	}
}

async function readRequestBody(
	request: Request,
): Promise<
	| { ok: true; body: PackageInvocationRequestBody }
	| { ok: false; response: Response }
> {
	let body: unknown
	try {
		body = (await request.json()) as unknown
	} catch {
		return {
			ok: false,
			response: jsonResponse(
				{
					ok: false,
					error: {
						code: 'invalid_json',
						message: 'Request body must be valid JSON.',
					},
				},
				{ status: 400 },
			),
		}
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return {
			ok: false,
			response: jsonResponse(
				{
					ok: false,
					error: {
						code: 'invalid_body',
						message: 'Request body must be a JSON object.',
					},
				},
				{ status: 400 },
			),
		}
	}
	return { ok: true, body: body as PackageInvocationRequestBody }
}

export function isPackageInvocationApiRequest(pathname: string) {
	return pathname.startsWith(packageInvocationPathPrefix)
}

export async function handlePackageInvocationApiRequest(
	request: Request,
	env: Env,
) {
	const route = parsePackageInvocationPath(new URL(request.url).pathname)
	if (!route) {
		return notFoundResponse()
	}
	if (request.method !== 'POST') {
		return jsonResponse(
			{
				ok: false,
				error: {
					code: 'method_not_allowed',
					message: 'Method not allowed.',
				},
			},
			{ status: 405, headers: { Allow: 'POST' } },
		)
	}
	const requestIp = getRequestIp(request) ?? undefined
	const bearerToken = readBearerToken(request)
	if (!bearerToken) {
		void logAuditEvent({
			category: 'oauth',
			action: 'package_invoke',
			result: 'failure',
			ip: requestIp,
			path: new URL(request.url).pathname,
			reason: 'missing_bearer_token',
		})
		return unauthorizedResponse()
	}
	const tokenScope = await resolveTokenScope({
		env,
		bearerToken,
	})
	if (!tokenScope) {
		void logAuditEvent({
			category: 'oauth',
			action: 'package_invoke',
			result: 'failure',
			ip: requestIp,
			path: new URL(request.url).pathname,
			reason: 'invalid_private_token',
		})
		return unauthorizedResponse('Invalid package invocation token.')
	}
	const parsedBody = await readRequestBody(request)
	if (!parsedBody.ok) {
		return parsedBody.response
	}
	const body = parsedBody.body
	const source = typeof body.source === 'string' ? body.source : null
	const topic = typeof body.topic === 'string' ? body.topic : null
	if (
		body.params !== undefined &&
		(!body.params ||
			typeof body.params !== 'object' ||
			Array.isArray(body.params))
	) {
		return jsonResponse(
			{
				ok: false,
				error: {
					code: 'invalid_params',
					message: 'params must be a JSON object when provided.',
				},
			},
			{ status: 400 },
		)
	}
	if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim()) {
		return jsonResponse(
			{
				ok: false,
				error: {
					code: 'missing_idempotency_key',
					message: 'Request body must include a non-empty idempotencyKey.',
				},
			},
			{ status: 400 },
		)
	}
	if (body.source != null && typeof body.source !== 'string') {
		return jsonResponse(
			{
				ok: false,
				error: {
					code: 'invalid_source',
					message: 'source must be a string when provided.',
				},
			},
			{ status: 400 },
		)
	}
	if (body.topic != null && typeof body.topic !== 'string') {
		return jsonResponse(
			{
				ok: false,
				error: {
					code: 'invalid_topic',
					message: 'topic must be a string when provided.',
				},
			},
			{ status: 400 },
		)
	}

	const response = await invokePackageExport({
		env,
		baseUrl: getAppBaseUrl({
			env,
			requestUrl: request.url,
		}),
		token: tokenScope,
		request: {
			packageIdOrKodyId: route.packageIdOrKodyId,
			exportName: route.exportName,
			params: body.params,
			idempotencyKey: body.idempotencyKey,
			source,
			topic,
		},
	})
	const result =
		response.status >= 200 && response.status < 400 ? 'success' : 'failure'
	const reason =
		response.status >= 400
			? String(
					(response.body['error'] as Record<string, unknown> | undefined)?.[
						'code'
					] ?? 'request_failed',
				)
			: undefined
	void logAuditEvent({
		category: 'oauth',
		action: 'package_invoke',
		result,
		email: tokenScope.email,
		ip: requestIp,
		path: new URL(request.url).pathname,
		reason,
	})
	return jsonResponse(response.body, { status: response.status })
}
