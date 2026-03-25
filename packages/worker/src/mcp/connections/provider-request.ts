import {
	getPrimarySecretFieldName,
	parseConnectionAuthSpec,
	type ConnectionAuthSpec,
	type ProviderRequestConfig,
} from './auth-spec.ts'
import { decryptJson, encryptJson } from './crypto.ts'
import {
	getProviderConnectionByIdUnsafe,
	getProviderConnectionSecret,
	updateProviderConnection,
	upsertProviderConnectionSecret,
} from './provider-connections-repo.ts'
import { type ProviderConnectionRow } from './provider-connections-types.ts'

type ProviderSecretMaterial = Record<string, unknown>

type ProviderHttpRequestInput = {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
	path: string
	query?: Record<string, string>
	body?: unknown
}

type ProviderHttpResponse = {
	status: number
	body: unknown | null
}

type ProviderGraphqlResponse = {
	status: number
	data: unknown | null
	errors: Array<unknown> | null
	extensions: unknown | null
}

const encryptedProviderSecretPurpose = 'provider-connection-secret'

export async function readProviderConnectionSecretMaterial(
	env: Env,
	connectionId: string,
) {
	const secretRow = await getProviderConnectionSecret(env.APP_DB, connectionId)
	if (!secretRow) {
		throw new Error('Provider connection secret material is missing.')
	}
	return decryptJson<ProviderSecretMaterial>(
		env,
		encryptedProviderSecretPurpose,
		secretRow.encrypted_secret_json,
	)
}

export async function writeProviderConnectionSecretMaterial(
	env: Env,
	connectionId: string,
	secretMaterial: ProviderSecretMaterial,
) {
	const encrypted = await encryptJson(
		env,
		encryptedProviderSecretPurpose,
		secretMaterial,
	)
	await upsertProviderConnectionSecret(env.APP_DB, {
		connection_id: connectionId,
		encrypted_secret_json: encrypted,
	})
}

export async function performProviderHttpRequestForConnection(
	env: Env,
	connection: ProviderConnectionRow,
	request: ProviderHttpRequestInput,
) {
	const secretMaterial = await readProviderConnectionSecretMaterial(
		env,
		connection.id,
	)
	const requestState = await prepareConnectionRequestState(
		env,
		connection,
		secretMaterial,
	)
	const response = await performProviderHttpRequestWithSpec({
		spec: requestState.spec,
		secretMaterial: requestState.secretMaterial,
		request,
	})
	await updateProviderConnection(
		env.APP_DB,
		connection.user_id,
		connection.id,
		{
			last_used_at: new Date().toISOString(),
			token_expires_at: requestState.tokenExpiresAt,
			scope_set: requestState.scopeSet,
		},
	)
	return response
}

export async function performProviderGraphqlRequestForConnection(
	env: Env,
	connection: ProviderConnectionRow,
	input: {
		query: string
		variables?: Record<string, unknown>
		operationName?: string
	},
) {
	const secretMaterial = await readProviderConnectionSecretMaterial(
		env,
		connection.id,
	)
	const requestState = await prepareConnectionRequestState(
		env,
		connection,
		secretMaterial,
	)
	const response = await performProviderGraphqlRequestWithSpec({
		spec: requestState.spec,
		secretMaterial: requestState.secretMaterial,
		query: input.query,
		variables: input.variables,
		operationName: input.operationName,
	})
	await updateProviderConnection(
		env.APP_DB,
		connection.user_id,
		connection.id,
		{
			last_used_at: new Date().toISOString(),
			token_expires_at: requestState.tokenExpiresAt,
			scope_set: requestState.scopeSet,
		},
	)
	return response
}

export async function verifyProviderConnectionDraft(input: {
	spec: ConnectionAuthSpec
	secretMaterial: ProviderSecretMaterial
}) {
	if (!input.spec.verification) return null
	return performProviderHttpRequestWithSpec({
		spec: input.spec,
		secretMaterial: input.secretMaterial,
		request: {
			method: input.spec.verification.method,
			path: input.spec.verification.path,
			query: input.spec.verification.query,
			body: input.spec.verification.body,
		},
	})
}

export function deriveConnectionPublicMetadata(input: {
	verificationBody: unknown
	fallbackLabel: string
	tokenScopeSet?: string | null
}) {
	const topLevel =
		input.verificationBody &&
		typeof input.verificationBody === 'object' &&
		!Array.isArray(input.verificationBody)
			? (input.verificationBody as Record<string, unknown>)
			: null
	const nestedResult =
		topLevel?.result &&
		typeof topLevel.result === 'object' &&
		!Array.isArray(topLevel.result)
			? (topLevel.result as Record<string, unknown>)
			: null
	const source = nestedResult ?? topLevel

	const accountId =
		source && source.id != null
			? String(source.id)
			: source && source.account_id != null
				? String(source.account_id)
				: null
	const accountLabel =
		(source && typeof source.login === 'string'
			? source.login
			: source && typeof source.name === 'string'
				? source.name
				: source && typeof source.email === 'string'
					? source.email
					: null) ?? input.fallbackLabel
	const scopeSet =
		input.tokenScopeSet ??
		(source &&
		Array.isArray(source.scopes) &&
		source.scopes.every((scope) => typeof scope === 'string')
			? JSON.stringify(source.scopes)
			: null)

	return {
		accountId,
		accountLabel,
		scopeSet,
	}
}

async function prepareConnectionRequestState(
	env: Env,
	connection: ProviderConnectionRow,
	initialSecretMaterial: ProviderSecretMaterial,
) {
	const spec = parseConnectionAuthSpec(connection.auth_spec_json)
	let secretMaterial = initialSecretMaterial
	let tokenExpiresAt = connection.token_expires_at
	let scopeSet = connection.scope_set

	if (
		(spec.strategy === 'oauth2_pre_registered_client' ||
			spec.strategy === 'oauth2_dynamic_client') &&
		shouldRefreshOAuthToken(connection.token_expires_at, secretMaterial)
	) {
		const refreshed = await refreshOAuthToken({
			env,
			connection,
			spec,
			secretMaterial,
		})
		secretMaterial = refreshed.secretMaterial
		tokenExpiresAt = refreshed.tokenExpiresAt
		scopeSet = refreshed.scopeSet
	}

	return {
		spec,
		secretMaterial,
		tokenExpiresAt,
		scopeSet,
	}
}

function shouldRefreshOAuthToken(
	tokenExpiresAt: string | null,
	secretMaterial: ProviderSecretMaterial,
) {
	if (!tokenExpiresAt) return false
	if (typeof secretMaterial['refresh_token'] !== 'string') return false
	return Date.parse(tokenExpiresAt) <= Date.now() + 30_000
}

async function refreshOAuthToken(input: {
	env: Env
	connection: ProviderConnectionRow
	spec: Extract<
		ConnectionAuthSpec,
		{
			strategy: 'oauth2_pre_registered_client' | 'oauth2_dynamic_client'
		}
	>
	secretMaterial: ProviderSecretMaterial
}) {
	const refreshToken = input.secretMaterial['refresh_token']
	if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
		return {
			secretMaterial: input.secretMaterial,
			tokenExpiresAt: input.connection.token_expires_at,
			scopeSet: input.connection.scope_set,
		}
	}

	const clientId =
		typeof input.secretMaterial['client_id'] === 'string'
			? input.secretMaterial['client_id']
			: null
	const clientSecret =
		typeof input.secretMaterial['client_secret'] === 'string'
			? input.secretMaterial['client_secret']
			: null
	const headers = new Headers({
		accept: 'application/json',
		'content-type': 'application/x-www-form-urlencoded',
	})
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
	})

	if (clientId && input.spec.token_auth_method === 'client_secret_post') {
		body.set('client_id', clientId)
		if (clientSecret) {
			body.set('client_secret', clientSecret)
		}
	}
	if (clientId && input.spec.token_auth_method === 'client_secret_basic') {
		headers.set(
			'authorization',
			`Basic ${btoa(`${clientId}:${clientSecret ?? ''}`)}`,
		)
	}

	const response = await fetch(input.spec.token_url, {
		method: 'POST',
		headers,
		body,
	})
	const parsed = await parseJsonResponse(response)
	if (!response.ok) {
		throw new Error(
			`OAuth token refresh failed (${response.status}). ${JSON.stringify(parsed.body)}`,
		)
	}

	const tokenBody =
		parsed.body &&
		typeof parsed.body === 'object' &&
		!Array.isArray(parsed.body)
			? (parsed.body as Record<string, unknown>)
			: {}
	const nextSecretMaterial = {
		...input.secretMaterial,
		access_token:
			typeof tokenBody['access_token'] === 'string'
				? tokenBody['access_token']
				: input.secretMaterial['access_token'],
		refresh_token:
			typeof tokenBody['refresh_token'] === 'string'
				? tokenBody['refresh_token']
				: input.secretMaterial['refresh_token'],
		token_type:
			typeof tokenBody['token_type'] === 'string'
				? tokenBody['token_type']
				: input.secretMaterial['token_type'],
	}
	const nextTokenExpiresAt =
		typeof tokenBody['expires_in'] === 'number'
			? new Date(Date.now() + tokenBody['expires_in'] * 1000).toISOString()
			: input.connection.token_expires_at
	const nextScopeSet =
		typeof tokenBody['scope'] === 'string'
			? JSON.stringify(
					tokenBody['scope']
						.split(/\s+/)
						.map((scope) => scope.trim())
						.filter(Boolean),
				)
			: input.connection.scope_set

	await writeProviderConnectionSecretMaterial(
		input.env,
		input.connection.id,
		nextSecretMaterial,
	)
	await updateProviderConnection(
		input.env.APP_DB,
		input.connection.user_id,
		input.connection.id,
		{
			token_expires_at: nextTokenExpiresAt,
			scope_set: nextScopeSet,
		},
	)

	return {
		secretMaterial: nextSecretMaterial,
		tokenExpiresAt: nextTokenExpiresAt,
		scopeSet: nextScopeSet,
	}
}

export async function performProviderHttpRequestWithSpec(input: {
	spec: ConnectionAuthSpec
	secretMaterial: ProviderSecretMaterial
	request: ProviderHttpRequestInput
}): Promise<ProviderHttpResponse> {
	assertSafeProviderPath(input.spec.request, input.request.path)
	const url = new URL(input.request.path, input.spec.request.base_url)
	if (input.request.query) {
		for (const [key, value] of Object.entries(input.request.query)) {
			url.searchParams.set(key, value)
		}
	}

	const response = await fetch(url, {
		method: input.request.method,
		headers: buildRequestHeaders(input.spec, input.secretMaterial),
		...(shouldSendJsonBody(input.request.method) &&
		input.request.body !== undefined
			? { body: JSON.stringify(input.request.body) }
			: {}),
	})
	return parseJsonResponse(response)
}

export async function performProviderGraphqlRequestWithSpec(input: {
	spec: ConnectionAuthSpec
	secretMaterial: ProviderSecretMaterial
	query: string
	variables?: Record<string, unknown>
	operationName?: string
}): Promise<ProviderGraphqlResponse> {
	const graphqlPath = input.spec.request.graphql_path
	if (!graphqlPath) {
		throw new Error(
			'This provider connection does not define a GraphQL endpoint.',
		)
	}
	const url = new URL(graphqlPath, input.spec.request.base_url)
	const headers = buildRequestHeaders(input.spec, input.secretMaterial)
	headers.set('content-type', 'application/json')
	const response = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			query: input.query,
			variables: input.variables,
			operationName: input.operationName,
		}),
	})
	const parsed = await parseJsonResponse(response)
	if (
		!parsed.body ||
		typeof parsed.body !== 'object' ||
		Array.isArray(parsed.body)
	) {
		return {
			status: parsed.status,
			data: null,
			errors: null,
			extensions: null,
		}
	}
	const payload = parsed.body as Record<string, unknown>
	return {
		status: parsed.status,
		data: payload['data'] ?? null,
		errors: Array.isArray(payload['errors']) ? payload['errors'] : null,
		extensions: payload['extensions'] ?? null,
	}
}

function buildRequestHeaders(
	spec: ConnectionAuthSpec,
	secretMaterial: ProviderSecretMaterial,
) {
	const headers = new Headers(spec.request.default_headers ?? {})
	headers.set('accept', headers.get('accept') ?? 'application/json')
	applyAuthTransport(headers, spec.request, spec, secretMaterial)
	if (headers.get('content-type') == null) {
		headers.set('content-type', 'application/json')
	}
	return headers
}

function applyAuthTransport(
	headers: Headers,
	request: ProviderRequestConfig,
	spec: ConnectionAuthSpec,
	secretMaterial: ProviderSecretMaterial,
) {
	const transport = request.auth_transport
	if (transport.type === 'bearer_header') {
		const secretField =
			transport.secret_field ?? getPrimarySecretFieldName(spec)
		const secret = secretField ? secretMaterial[secretField] : null
		if (typeof secret !== 'string' || secret.length === 0) {
			throw new Error(`Missing bearer token secret field "${secretField}".`)
		}
		headers.set(transport.header_name, `${transport.prefix}${secret}`)
		return
	}
	if (transport.type === 'api_key_header') {
		const secretField =
			transport.secret_field ?? getPrimarySecretFieldName(spec)
		const secret = secretField ? secretMaterial[secretField] : null
		if (typeof secret !== 'string' || secret.length === 0) {
			throw new Error(`Missing API key secret field "${secretField}".`)
		}
		headers.set(
			transport.header_name,
			`${transport.prefix ?? ''}${String(secret)}`,
		)
		return
	}
	const secretField = transport.secret_field ?? getPrimarySecretFieldName(spec)
	const secret = secretField ? secretMaterial[secretField] : null
	if (typeof secret !== 'string' || secret.length === 0) {
		throw new Error(`Missing basic-auth secret field "${secretField}".`)
	}
	headers.set('authorization', `Basic ${btoa(`${secret}:`)}`)
}

function shouldSendJsonBody(method: string) {
	return (
		method === 'POST' ||
		method === 'PUT' ||
		method === 'PATCH' ||
		method === 'DELETE'
	)
}

function assertSafeProviderPath(config: ProviderRequestConfig, path: string) {
	const trimmed = path.trim()
	if (!trimmed.startsWith('/')) {
		throw new Error(
			'path must start with `/` and must not include a host or absolute URL.',
		)
	}
	if (trimmed.includes('..')) {
		throw new Error('path must not contain `..` segments.')
	}
	if (/[\s#]/.test(trimmed)) {
		throw new Error('path contains disallowed characters.')
	}
	if (config.path_prefix && !trimmed.startsWith(config.path_prefix)) {
		throw new Error(
			`path must start with \`${config.path_prefix}\` for this provider connection.`,
		)
	}
}

async function parseJsonResponse(
	response: Response,
): Promise<ProviderHttpResponse> {
	const text = await response.text()
	if (response.status === 204 || !text.trim()) {
		return {
			status: response.status,
			body: null,
		}
	}
	try {
		return {
			status: response.status,
			body: JSON.parse(text) as unknown,
		}
	} catch {
		throw new Error(`Provider returned non-JSON (${response.status}).`)
	}
}

export async function getVerifiedProviderConnection(
	env: Env,
	connectionId: string,
) {
	const connection = await getProviderConnectionByIdUnsafe(
		env.APP_DB,
		connectionId,
	)
	if (!connection) {
		throw new Error('Provider connection not found.')
	}
	return connection
}
