import {
	buildIntegrationValueName,
	parseIntegrationConfig,
	parseIntegrationJson,
	type IntegrationConfig,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { assertIntegrationHostAllowed } from '#mcp/execute-modules/integration-host-allowlist.ts'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import {
	buildBasicAuthSecretPlaceholder,
	buildSecretPlaceholder,
} from '#mcp/secrets/placeholders.ts'
import { assertPackageCanAccessResolvedSecret } from '#mcp/secrets/package-access.ts'
import {
	resolveSecret,
	saveSecret,
	updateUserSecretForPackage,
} from '#mcp/secrets/service.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { getValue } from '#mcp/values/service.ts'
import {
	normalizeApiBaseUrl,
	type OpenApiBinding,
	type OpenApiBindingOperation,
} from '#worker/openapi/binding-shared.ts'

export const openApiOperationResponseMaxBytes = 300_000

export type OpenApiOperationRequestArgs = {
	params?: Record<string, unknown>
	query?: Record<string, unknown>
	headers?: Record<string, unknown>
	body?: unknown
}

export type OpenApiOperationRequestResult = {
	status: number
	ok: boolean
	contentType: string | null
	body: unknown
	truncated: boolean
}

export async function executeOpenApiOperationRequest(input: {
	env: Env
	userId: string
	baseUrl: string
	storageContext: StorageContext | null
	binding: OpenApiBinding
	operation: OpenApiBindingOperation
	args: OpenApiOperationRequestArgs
	globalFetch?: typeof fetch
}): Promise<OpenApiOperationRequestResult> {
	const args = input.args ?? {}
	const params = asStringRecord(args.params, 'params')
	const query = args.query ?? {}
	const userHeaders = asStringRecord(args.headers, 'headers')

	const url = buildOperationUrl({
		apiBaseUrl: input.binding.apiBaseUrl,
		path: input.operation.path,
		params,
		query,
	})
	assertPinnedToApiBaseUrl(url, input.binding.apiBaseUrl)

	let integration: IntegrationConfig | null = null
	if (input.binding.auth.kind === 'integration') {
		integration = await loadIntegrationConfig({
			env: input.env,
			userId: input.userId,
			provider: input.binding.auth.provider,
		})
		assertIntegrationHostAllowed(input.binding.auth.provider, integration, url)
	}

	const headers = buildRequestHeaders({
		userHeaders,
		auth: input.binding.auth,
		integration,
		requestBody: input.operation.requestBody,
		hasBody: args.body !== undefined,
	})

	const requestInit: RequestInit = {
		method: input.operation.method.toUpperCase(),
		headers,
	}
	if (args.body !== undefined && shouldSendBody(input.operation)) {
		requestInit.body = serializeBody(args.body, input.operation)
	}

	const request = new Request(url.toString(), requestInit)
	let response = await executeGatewayFetch({
		env: input.env,
		props: {
			baseUrl: input.baseUrl,
			userId: input.userId,
			email: null,
			storageContext: input.storageContext,
		},
		request,
		globalFetch: input.globalFetch,
	})

	if (
		response.status === 401 &&
		input.binding.auth.kind === 'integration' &&
		integration
	) {
		const refreshed = await tryRefreshIntegrationAccessToken({
			env: input.env,
			userId: input.userId,
			baseUrl: input.baseUrl,
			provider: input.binding.auth.provider,
			integration,
			storageContext: input.storageContext,
			globalFetch: input.globalFetch,
		})
		if (refreshed.ok) {
			void response.body?.cancel().catch(() => {})
			response = await executeGatewayFetch({
				env: input.env,
				props: {
					baseUrl: input.baseUrl,
					userId: input.userId,
					email: null,
					storageContext: input.storageContext,
				},
				request: new Request(url.toString(), requestInit),
				globalFetch: input.globalFetch,
			})
		} else if (refreshed.guidance) {
			const result = await readOperationResponse(response)
			return {
				...result,
				body:
					typeof result.body === 'object' && result.body !== null
						? {
								...(result.body as Record<string, unknown>),
								kodyGuidance: refreshed.guidance,
							}
						: {
								upstreamBody: result.body,
								kodyGuidance: refreshed.guidance,
							},
			}
		}
	}

	return readOperationResponse(response)
}

function buildOperationUrl(input: {
	apiBaseUrl: string
	path: string
	params: Record<string, string>
	query: Record<string, unknown>
}) {
	const base = normalizeApiBaseUrl(input.apiBaseUrl)
	let path = input.path.trim()
	path = path.replace(/\{([^}/]+)\}/g, (_match, name: string) => {
		if (!(name in input.params)) {
			throw new Error(
				`Missing required path parameter "${name}" for OpenAPI operation path ${input.path}.`,
			)
		}
		return encodeURIComponent(input.params[name] ?? '')
	})
	// Concatenate onto apiBaseUrl (never resolve as a URL reference) so a base
	// path segment like /v1 is preserved, and reject absolute or
	// protocol-relative spec paths — they must never widen outbound hosts.
	if (!path.startsWith('/') || path.startsWith('//')) {
		throw new Error(
			`OpenAPI operation path ${JSON.stringify(input.path)} must be relative to the binding apiBaseUrl (a single leading "/"). Spec paths never override the binding host.`,
		)
	}
	const url = new URL(`${base}${path}`)
	appendQueryParams(url, input.query)
	return url
}

function appendQueryParams(url: URL, query: Record<string, unknown>) {
	for (const [key, value] of Object.entries(query)) {
		if (value == null) continue
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (entry == null) continue
				url.searchParams.append(key, String(entry))
			}
			continue
		}
		url.searchParams.append(key, String(value))
	}
}

function assertPinnedToApiBaseUrl(url: URL, apiBaseUrl: string) {
	const expectedHost = new URL(normalizeApiBaseUrl(apiBaseUrl)).host
	if (url.host !== expectedHost) {
		throw new Error(
			`OpenAPI operation URL host "${url.host}" does not match binding apiBaseUrl host "${expectedHost}". Outbound requests are pinned to the binding apiBaseUrl; spec servers never widen host approval.`,
		)
	}
}

async function loadIntegrationConfig(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	provider: string
}): Promise<IntegrationConfig> {
	const value = await getValue({
		env: input.env,
		userId: input.userId,
		name: buildIntegrationValueName(input.provider),
		scope: 'user',
		storageContext: null,
	})
	if (!value) {
		throw new Error(
			`Integration "${input.provider}" was not found for OpenAPI binding auth.`,
		)
	}
	const parsed = parseIntegrationConfig(
		parseIntegrationJson(value.value),
		input.provider,
	)
	if (!parsed) {
		throw new Error(
			`Integration "${input.provider}" config is invalid for OpenAPI binding auth.`,
		)
	}
	return parsed
}

function buildRequestHeaders(input: {
	userHeaders: Record<string, string>
	auth: OpenApiBinding['auth']
	integration: IntegrationConfig | null
	requestBody: OpenApiBindingOperation['requestBody']
	hasBody: boolean
}) {
	const headers = new Headers()
	for (const [name, value] of Object.entries(input.userHeaders)) {
		headers.set(name, value)
	}
	if (!headers.has('accept')) {
		headers.set('accept', 'application/json')
	}
	if (
		input.hasBody &&
		input.requestBody &&
		(input.requestBody.contentType == null ||
			isJsonContentType(input.requestBody.contentType)) &&
		!headers.has('content-type')
	) {
		headers.set(
			'content-type',
			input.requestBody.contentType ?? 'application/json',
		)
	}

	// Auth-controlled headers always win over caller-supplied values.
	switch (input.auth.kind) {
		case 'none':
			break
		case 'bearerSecret': {
			headers.delete('authorization')
			headers.set(
				'authorization',
				`Bearer ${buildSecretPlaceholder({
					name: input.auth.secretName,
					scope: null,
				})}`,
			)
			break
		}
		case 'headerSecret': {
			headers.delete(input.auth.headerName)
			headers.set(
				input.auth.headerName,
				buildSecretPlaceholder({
					name: input.auth.secretName,
					scope: null,
				}),
			)
			break
		}
		case 'basicSecrets': {
			headers.delete('authorization')
			headers.set(
				'authorization',
				buildBasicAuthSecretPlaceholder({
					usernameSecret: input.auth.usernameSecret,
					passwordSecret: input.auth.passwordSecret,
				}),
			)
			break
		}
		case 'integration': {
			if (!input.integration) {
				throw new Error(
					`Integration "${input.auth.provider}" was not loaded for OpenAPI auth.`,
				)
			}
			const accessTokenSecretName =
				input.integration.accessTokenSecretName.trim()
			if (!accessTokenSecretName) {
				throw new Error(
					`Integration "${input.auth.provider}" does not define an access token secret name.`,
				)
			}
			headers.delete('authorization')
			headers.set(
				'authorization',
				`Bearer ${buildSecretPlaceholder({
					name: accessTokenSecretName,
					scope: 'user',
				})}`,
			)
			break
		}
		default: {
			const _exhaustive: never = input.auth
			throw new Error(
				`Unsupported OpenAPI auth kind: ${JSON.stringify(_exhaustive)}`,
			)
		}
	}
	return headers
}

function shouldSendBody(operation: OpenApiBindingOperation) {
	const method = operation.method
	return method !== 'get' && method !== 'head'
}

function serializeBody(
	body: unknown,
	operation: OpenApiBindingOperation,
): string {
	const contentType = operation.requestBody?.contentType ?? null
	if (contentType == null || isJsonContentType(contentType)) {
		return JSON.stringify(body ?? null)
	}
	if (typeof body === 'string') return body
	return JSON.stringify(body)
}

function isJsonContentType(contentType: string): boolean {
	const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
	return (
		mediaType === 'application/json' ||
		mediaType === 'text/json' ||
		mediaType.endsWith('+json')
	)
}

async function tryRefreshIntegrationAccessToken(input: {
	env: Env
	userId: string
	baseUrl: string
	provider: string
	integration: IntegrationConfig
	storageContext: StorageContext | null
	globalFetch?: typeof fetch
}): Promise<{ ok: boolean; guidance?: string }> {
	const refreshTokenSecretName =
		input.integration.refreshTokenSecretName?.trim() ?? ''
	if (!refreshTokenSecretName) {
		return {
			ok: false,
			guidance: `OpenAPI request returned HTTP 401 and integration "${input.provider}" has no refreshTokenSecretName. Call refreshAccessToken("${input.provider}") from execute, then retry.`,
		}
	}

	let clientId: string
	try {
		clientId = await readClientIdValue({
			env: input.env,
			userId: input.userId,
			valueName: input.integration.clientIdValueName,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return {
			ok: false,
			guidance: `OpenAPI request returned HTTP 401; host-side token refresh could not read client id: ${message}. Call refreshAccessToken("${input.provider}") from execute, then retry.`,
		}
	}

	const params = new URLSearchParams()
	params.set('grant_type', 'refresh_token')
	params.set(
		'refresh_token',
		buildSecretPlaceholder({ name: refreshTokenSecretName, scope: 'user' }),
	)
	params.set('client_id', clientId)
	if (input.integration.flow === 'confidential') {
		const clientSecretSecretName =
			input.integration.clientSecretSecretName?.trim() ?? ''
		if (!clientSecretSecretName) {
			return {
				ok: false,
				guidance: `OpenAPI request returned HTTP 401; integration "${input.provider}" uses confidential flow but has no clientSecretSecretName. Call refreshAccessToken("${input.provider}") from execute, then retry.`,
			}
		}
		params.set(
			'client_secret',
			buildSecretPlaceholder({
				name: clientSecretSecretName,
				scope: 'user',
			}),
		)
	}

	let refreshResponse: Response
	try {
		refreshResponse = await executeGatewayFetch({
			env: input.env,
			props: {
				baseUrl: input.baseUrl,
				userId: input.userId,
				email: null,
				storageContext: input.storageContext,
			},
			request: new Request(input.integration.tokenUrl, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: params.toString(),
			}),
			globalFetch: input.globalFetch,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return {
			ok: false,
			guidance: `OpenAPI request returned HTTP 401; host-side token refresh failed: ${message}. Call refreshAccessToken("${input.provider}") from execute, then retry.`,
		}
	}

	let payload: Record<string, unknown>
	try {
		payload = (await refreshResponse.json()) as Record<string, unknown>
	} catch {
		return {
			ok: false,
			guidance: `OpenAPI request returned HTTP 401; token refresh response was not JSON. Call refreshAccessToken("${input.provider}") from execute, then retry.`,
		}
	}

	if (!refreshResponse.ok || typeof payload.access_token !== 'string') {
		return {
			ok: false,
			guidance: `OpenAPI request returned HTTP 401; token refresh failed with HTTP ${refreshResponse.status}. Call refreshAccessToken("${input.provider}") from execute, then retry.`,
		}
	}

	await saveUserSecretFromOpenApiRefresh({
		env: input.env,
		userId: input.userId,
		baseUrl: input.baseUrl,
		storageContext: input.storageContext,
		name: input.integration.accessTokenSecretName,
		value: payload.access_token,
		description: `Access token for integration ${input.provider}`,
	})
	if (
		typeof payload.refresh_token === 'string' &&
		payload.refresh_token.length > 0
	) {
		await saveUserSecretFromOpenApiRefresh({
			env: input.env,
			userId: input.userId,
			baseUrl: input.baseUrl,
			storageContext: input.storageContext,
			name: refreshTokenSecretName,
			value: payload.refresh_token,
			description: `Refresh token for integration ${input.provider}`,
		})
	}
	return { ok: true }
}

async function saveUserSecretFromOpenApiRefresh(input: {
	env: Env
	userId: string
	baseUrl: string
	storageContext: StorageContext | null
	name: string
	value: string
	description: string
}) {
	const packageId = input.storageContext?.packageId?.trim() ?? ''
	if (packageId) {
		await assertPackageCanUpdateUserSecret({
			env: input.env,
			userId: input.userId,
			baseUrl: input.baseUrl,
			storageContext: input.storageContext,
			secretName: input.name,
		})
		return updateUserSecretForPackage({
			env: input.env,
			userId: input.userId,
			packageId,
			name: input.name,
			value: input.value,
			description: input.description,
		})
	}
	return saveSecret({
		env: input.env,
		userId: input.userId,
		name: input.name,
		value: input.value,
		scope: 'user',
		description: input.description,
		storageContext: input.storageContext,
	})
}

async function assertPackageCanUpdateUserSecret(input: {
	env: Env
	userId: string
	baseUrl: string
	storageContext: StorageContext | null
	secretName: string
}) {
	if (!input.storageContext?.packageId) return
	const resolved = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: input.secretName,
		scope: 'user',
		storageContext: input.storageContext,
	})
	if (!resolved.found) {
		throw new Error(
			`Package runtime cannot create missing user secret "${input.secretName}" during OpenAPI token refresh.`,
		)
	}
	await assertPackageCanAccessResolvedSecret({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		storageContext: input.storageContext,
		secretName: input.secretName,
		resolved,
		intent: 'mutate',
	})
}

async function readClientIdValue(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	valueName: string
}) {
	const value = await getValue({
		env: input.env,
		userId: input.userId,
		name: input.valueName,
		scope: 'user',
		storageContext: null,
	})
	if (!value?.value) {
		throw new Error(`Client ID value "${input.valueName}" was not found.`)
	}
	return value.value
}

async function readOperationResponse(
	response: Response,
): Promise<OpenApiOperationRequestResult> {
	const contentType = response.headers.get('content-type')
	const { text: bodyText, truncated } = await readBoundedBodyAllowTruncate(
		response,
		openApiOperationResponseMaxBytes,
	)

	const isJson = contentType != null && isJsonContentType(contentType)
	let body: unknown = bodyText
	if (isJson && !truncated) {
		try {
			body = JSON.parse(bodyText)
		} catch {
			body = bodyText
		}
	}

	return {
		status: response.status,
		ok: response.ok,
		contentType,
		body,
		truncated,
	}
}

async function readBoundedBodyAllowTruncate(
	response: Response,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	const contentLengthHeader = response.headers.get('Content-Length')
	if (contentLengthHeader != null) {
		const contentLength = Number(contentLengthHeader)
		if (Number.isFinite(contentLength) && contentLength > maxBytes) {
			// Still stream up to the cap so callers get a useful preview.
		}
	}

	if (response.body == null) {
		const text = await response.text()
		const bytes = new TextEncoder().encode(text)
		if (bytes.byteLength <= maxBytes) {
			return { text, truncated: false }
		}
		return {
			text: new TextDecoder().decode(bytes.slice(0, maxBytes)),
			truncated: true,
		}
	}

	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	const chunks: Array<Uint8Array> = []
	let totalBytes = 0
	let truncated = false

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value || value.byteLength === 0) continue
			if (totalBytes + value.byteLength > maxBytes) {
				const remaining = maxBytes - totalBytes
				if (remaining > 0) chunks.push(value.slice(0, remaining))
				totalBytes = maxBytes
				truncated = true
				void reader.cancel().catch(() => {})
				break
			}
			chunks.push(value)
			totalBytes += value.byteLength
		}
	} catch (error) {
		void reader.cancel().catch(() => {})
		throw error
	}

	const merged = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		merged.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { text: decoder.decode(merged), truncated }
}

function asStringRecord(
	value: Record<string, unknown> | undefined,
	fieldName: string,
): Record<string, string> {
	if (value == null) return {}
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`OpenAPI operation args.${fieldName} must be an object.`)
	}
	const result: Record<string, string> = {}
	for (const [key, entry] of Object.entries(value)) {
		if (entry == null) continue
		if (typeof entry !== 'string' && typeof entry !== 'number') {
			throw new Error(
				`OpenAPI operation args.${fieldName}.${key} must be a string or number.`,
			)
		}
		result[key] = String(entry)
	}
	return result
}
