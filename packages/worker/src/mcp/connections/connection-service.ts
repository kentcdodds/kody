import {
	connectionSelectionSchema,
	getAuthSpecSecretFields,
	parseConnectionAuthSpec,
	type ConnectionAuthSpec,
	type ConnectionSelection,
} from './auth-spec.ts'
import {
	createConnectionHandle,
	verifyConnectionHandle,
} from './connection-handles.ts'
import {
	deleteConnectionDraftSecrets,
	getConnectionDraftById,
	getConnectionDraftByIdUnsafe,
	insertConnectionDraft,
	listConnectionDraftSecrets,
	updateConnectionDraft,
	updateConnectionDraftUnsafe,
	upsertConnectionDraftSecret,
} from './connection-drafts-repo.ts'
import {
	base64UrlEncode,
	decryptJson,
	encryptJson,
	signToken,
	verifyToken,
} from './crypto.ts'
import {
	deleteProviderConnection,
	getProviderConnectionById,
	getProviderConnectionByIdUnsafe,
	insertProviderConnection,
	listProviderConnectionsByProvider,
	listProviderConnectionsByUserId,
	setProviderConnectionDefault,
} from './provider-connections-repo.ts'
import {
	deriveConnectionPublicMetadata,
	performProviderGraphqlRequestForConnection,
	performProviderHttpRequestForConnection,
	verifyProviderConnectionDraft,
	writeProviderConnectionSecretMaterial,
} from './provider-request.ts'

const encryptedDraftSecretPurpose = 'connection-draft-secret'
const oauthStatePurpose = 'connection-oauth-state'
const connectionDraftTtlMs = 24 * 60 * 60 * 1000

type DraftSecretMaterial = Record<string, string>

export async function beginConnectionSetup(input: {
	env: Env
	userId: string
	provider: {
		key: string
		display_name: string
	}
	auth: ConnectionAuthSpec
	label?: string
}) {
	const now = Date.now()
	const draftId = crypto.randomUUID()
	const status = getInitialDraftStatus(input.auth)
	await insertConnectionDraft(input.env.APP_DB, {
		id: draftId,
		user_id: input.userId,
		provider_key: input.provider.key,
		display_name: input.provider.display_name,
		label: input.label ?? null,
		auth_spec_json: JSON.stringify(input.auth),
		status,
		state_json: null,
		error_message: null,
		expires_at: new Date(now + connectionDraftTtlMs).toISOString(),
	})
	return {
		setup_id: draftId,
		provider: input.provider,
		label: input.label ?? null,
		auth_strategy: input.auth.strategy,
		status,
		secret_fields: getAuthSpecSecretFields(input.auth),
		instructions: getSetupInstructions(input.auth),
		expires_at: new Date(now + connectionDraftTtlMs).toISOString(),
	}
}

export async function storeDraftSecrets(input: {
	env: Env
	userId: string
	draftId: string
	fields: Record<string, string>
}) {
	const draft = await getRequiredConnectionDraft(
		input.env,
		input.userId,
		input.draftId,
	)
	const spec = parseConnectionAuthSpec(draft.auth_spec_json)
	const allowedFields = new Set(
		getAuthSpecSecretFields(spec).map((field) => field.name),
	)
	for (const [name, value] of Object.entries(input.fields)) {
		if (!allowedFields.has(name)) {
			throw new Error(`Secret field "${name}" is not allowed for this draft.`)
		}
		const encryptedValue = await encryptJson(
			input.env,
			encryptedDraftSecretPurpose,
			value,
		)
		await upsertConnectionDraftSecret(input.env.APP_DB, {
			draft_id: draft.id,
			secret_name: name,
			encrypted_value: encryptedValue,
		})
	}
	const secretMaterial = await loadDraftSecretMaterial(input.env, draft.id)
	const nextStatus = getDraftStatusAfterSecrets(spec, secretMaterial)
	await updateConnectionDraft(input.env.APP_DB, draft.id, input.userId, {
		status: nextStatus,
		error_message: null,
	})
	return {
		setup_id: draft.id,
		status: nextStatus,
		stored_secret_names: Object.keys(input.fields).sort(),
		missing_secret_names: getMissingSecretNames(spec, secretMaterial),
	}
}

export async function startConnectionOAuth(input: {
	env: Env
	userId: string
	draftId: string
	baseUrl: string
}) {
	const draft = await getRequiredConnectionDraft(
		input.env,
		input.userId,
		input.draftId,
	)
	const spec = parseConnectionAuthSpec(draft.auth_spec_json)
	if (
		spec.strategy !== 'oauth2_pre_registered_client' &&
		spec.strategy !== 'oauth2_dynamic_client'
	) {
		throw new Error('This connection draft does not use OAuth.')
	}

	let secretMaterial = await loadDraftSecretMaterial(input.env, draft.id)
	if (spec.strategy === 'oauth2_dynamic_client') {
		secretMaterial = await ensureDynamicClientRegistration({
			env: input.env,
			draftId: draft.id,
			spec,
			secretMaterial,
		})
	}

	const missingSecretNames = getMissingOAuthClientSecretNames(
		spec,
		secretMaterial,
	)
	if (missingSecretNames.length > 0) {
		throw new Error(
			`OAuth client secrets are missing for this draft: ${missingSecretNames.join(', ')}`,
		)
	}

	const clientId = secretMaterial['client_id']
	if (!clientId) {
		throw new Error(
			'OAuth client_id is required before starting authorization.',
		)
	}
	const callbackUrl = new URL('/api/connections/oauth/callback', input.baseUrl)
	const stateToken = await signToken(input.env, oauthStatePurpose, {
		draft_id: draft.id,
		user_id: draft.user_id,
		exp: Date.now() + 10 * 60 * 1000,
	})
	const codeVerifier =
		spec.use_pkce === true
			? base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
			: null
	const authorizeUrl = new URL(spec.authorize_url)
	authorizeUrl.searchParams.set('response_type', 'code')
	authorizeUrl.searchParams.set('client_id', clientId)
	authorizeUrl.searchParams.set('redirect_uri', callbackUrl.toString())
	if (spec.scopes.length > 0) {
		authorizeUrl.searchParams.set('scope', spec.scopes.join(' '))
	}
	authorizeUrl.searchParams.set('state', stateToken)
	if (spec.use_pkce && codeVerifier) {
		authorizeUrl.searchParams.set(
			'code_challenge',
			await createPkceCodeChallenge(codeVerifier),
		)
		authorizeUrl.searchParams.set('code_challenge_method', 'S256')
	}

	await updateConnectionDraft(input.env.APP_DB, draft.id, input.userId, {
		status: 'awaiting_oauth_callback',
		state_json: JSON.stringify({
			redirect_uri: callbackUrl.toString(),
			code_verifier: codeVerifier,
			started_at: new Date().toISOString(),
		}),
		error_message: null,
	})

	return {
		setup_id: draft.id,
		authorize_url: authorizeUrl.toString(),
		status: 'awaiting_oauth_callback',
	}
}

export async function finalizeConnectionSetup(input: {
	env: Env
	userId: string
	draftId: string
	makeDefault?: boolean
}) {
	const draft = await getRequiredConnectionDraft(
		input.env,
		input.userId,
		input.draftId,
	)
	const spec = parseConnectionAuthSpec(draft.auth_spec_json)
	const secretMaterial = await loadDraftSecretMaterial(input.env, draft.id)
	const missingSecretNames = getMissingSecretNames(spec, secretMaterial)
	if (missingSecretNames.length > 0) {
		throw new Error(
			`Connection draft is missing required secret fields: ${missingSecretNames.join(', ')}`,
		)
	}

	const verification = await verifyProviderConnectionDraft({
		spec,
		secretMaterial,
	})
	const connectionId = crypto.randomUUID()
	const existingConnections = await listProviderConnectionsByProvider(
		input.env.APP_DB,
		input.userId,
		draft.provider_key,
	)
	const label = await buildUniqueConnectionLabel({
		env: input.env,
		userId: input.userId,
		providerKey: draft.provider_key,
		preferredLabel:
			draft.label ??
			verificationLabelFromBody(verification?.body) ??
			`${draft.provider_key}-connection`,
	})
	const tokenScopeSet =
		typeof secretMaterial['scope'] === 'string'
			? JSON.stringify(
					secretMaterial['scope']
						.split(/\s+/)
						.map((scope) => scope.trim())
						.filter(Boolean),
				)
			: null
	const derivedMetadata = deriveConnectionPublicMetadata({
		verificationBody: verification?.body ?? null,
		fallbackLabel: label,
		tokenScopeSet,
	})
	const tokenExpiresAt =
		typeof secretMaterial['expires_at'] === 'string'
			? secretMaterial['expires_at']
			: null
	const shouldBeDefault =
		input.makeDefault === true || existingConnections.length === 0 ? 1 : 0

	await insertProviderConnection(input.env.APP_DB, {
		id: connectionId,
		user_id: input.userId,
		provider_key: draft.provider_key,
		display_name: draft.display_name,
		label,
		auth_spec_json: draft.auth_spec_json,
		status: 'active',
		account_id: derivedMetadata.accountId,
		account_label: derivedMetadata.accountLabel,
		scope_set: derivedMetadata.scopeSet,
		metadata_json: null,
		is_default: shouldBeDefault,
		token_expires_at: tokenExpiresAt,
		last_used_at: null,
	})
	await writeProviderConnectionSecretMaterial(
		input.env,
		connectionId,
		secretMaterial,
	)
	if (shouldBeDefault === 1) {
		await setProviderConnectionDefault(
			input.env.APP_DB,
			input.userId,
			draft.provider_key,
			connectionId,
		)
	}
	await deleteConnectionDraftSecrets(input.env.APP_DB, draft.id)
	await updateConnectionDraft(input.env.APP_DB, draft.id, input.userId, {
		status: 'completed',
		error_message: null,
	})
	return {
		connection_id: connectionId,
		provider_key: draft.provider_key,
		display_name: draft.display_name,
		label,
		account_id: derivedMetadata.accountId,
		account_label: derivedMetadata.accountLabel,
		scope_set: parseScopeSet(derivedMetadata.scopeSet),
		is_default: shouldBeDefault === 1,
		status: 'active',
	}
}

export async function listConnectionsForUser(env: Env, userId: string) {
	const connections = await listProviderConnectionsByUserId(env.APP_DB, userId)
	return connections.map((connection) => ({
		connection_id: connection.id,
		provider_key: connection.provider_key,
		display_name: connection.display_name,
		label: connection.label,
		account_id: connection.account_id,
		account_label: connection.account_label,
		scope_set: parseScopeSet(connection.scope_set),
		is_default: connection.is_default === 1,
		status: connection.status,
		created_at: connection.created_at,
		updated_at: connection.updated_at,
		last_used_at: connection.last_used_at,
		token_expires_at: connection.token_expires_at,
	}))
}

export async function setConnectionDefault(input: {
	env: Env
	userId: string
	connectionId: string
}) {
	const connection = await getRequiredProviderConnection(
		input.env,
		input.userId,
		input.connectionId,
	)
	await setProviderConnectionDefault(
		input.env.APP_DB,
		input.userId,
		connection.provider_key,
		connection.id,
	)
	return {
		connection_id: connection.id,
		provider_key: connection.provider_key,
		is_default: true,
	}
}

export async function disconnectConnection(input: {
	env: Env
	userId: string
	connectionId: string
}) {
	const connection = await getRequiredProviderConnection(
		input.env,
		input.userId,
		input.connectionId,
	)
	const deleted = await deleteProviderConnection(
		input.env.APP_DB,
		input.userId,
		connection.id,
	)
	if (!deleted) {
		throw new Error('Provider connection not found.')
	}
	const remainingConnections = await listProviderConnectionsByProvider(
		input.env.APP_DB,
		input.userId,
		connection.provider_key,
	)
	if (connection.is_default === 1 && remainingConnections.length > 0) {
		await setProviderConnectionDefault(
			input.env.APP_DB,
			input.userId,
			connection.provider_key,
			remainingConnections[0]!.id,
		)
	}
	return {
		connection_id: connection.id,
		disconnected: true,
	}
}

export async function resolveConnection(input: {
	env: Env
	userId: string
	provider: string
	selection: ConnectionSelection
	allowMissing?: boolean
}) {
	const selection = connectionSelectionSchema.parse(input.selection)
	const providerConnections = await listProviderConnectionsByProvider(
		input.env.APP_DB,
		input.userId,
		input.provider,
	)
	const matchedConnection = pickConnection(providerConnections, selection)
	if (!matchedConnection) {
		if (input.allowMissing === true) {
			return {
				found: false as const,
			}
		}
		throw new Error(
			`No connection matched provider "${input.provider}" using strategy "${selection.strategy}".`,
		)
	}
	const handle = await createConnectionHandle(input.env, {
		connectionId: matchedConnection.id,
		userId: input.userId,
		providerKey: matchedConnection.provider_key,
	})
	return {
		found: true as const,
		handle,
		connection_id: matchedConnection.id,
		provider_key: matchedConnection.provider_key,
		display_name: matchedConnection.display_name,
		label: matchedConnection.label,
		account_id: matchedConnection.account_id,
		account_label: matchedConnection.account_label,
		is_default: matchedConnection.is_default === 1,
	}
}

export async function performResolvedProviderHttpRequest(input: {
	env: Env
	userId: string
	handle: string
	request: {
		method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
		path: string
		query?: Record<string, string>
		body?: unknown
	}
}) {
	const payload = await verifyConnectionHandle(input.env, input.handle)
	if (payload.user_id !== input.userId) {
		throw new Error('Connection handle does not belong to the current user.')
	}
	const connection = await getProviderConnectionByIdUnsafe(
		input.env.APP_DB,
		payload.connection_id,
	)
	if (!connection) {
		throw new Error('Provider connection not found for this handle.')
	}
	return performProviderHttpRequestForConnection(
		input.env,
		connection,
		input.request,
	)
}

export async function performResolvedProviderGraphqlRequest(input: {
	env: Env
	userId: string
	handle: string
	query: string
	variables?: Record<string, unknown>
	operationName?: string
}) {
	const payload = await verifyConnectionHandle(input.env, input.handle)
	if (payload.user_id !== input.userId) {
		throw new Error('Connection handle does not belong to the current user.')
	}
	const connection = await getProviderConnectionByIdUnsafe(
		input.env.APP_DB,
		payload.connection_id,
	)
	if (!connection) {
		throw new Error('Provider connection not found for this handle.')
	}
	return performProviderGraphqlRequestForConnection(input.env, connection, {
		query: input.query,
		variables: input.variables,
		operationName: input.operationName,
	})
}

export async function refreshResolvedProviderConnection(input: {
	env: Env
	userId: string
	handle: string
}) {
	const payload = await verifyConnectionHandle(input.env, input.handle)
	if (payload.user_id !== input.userId) {
		throw new Error('Connection handle does not belong to the current user.')
	}
	const connection = await getProviderConnectionByIdUnsafe(
		input.env.APP_DB,
		payload.connection_id,
	)
	if (!connection) {
		throw new Error('Provider connection not found for this handle.')
	}
	const verificationPath = parseConnectionAuthSpec(connection.auth_spec_json)
		.verification?.path
	if (!verificationPath) {
		throw new Error(
			'Provider connection does not define a verification path for refresh.',
		)
	}
	const response = await performProviderHttpRequestForConnection(
		input.env,
		connection,
		{
			method: 'GET',
			path: verificationPath,
		},
	)
	return {
		connection_id: connection.id,
		status: response.status,
	}
}

export async function handleConnectionOAuthCallback(
	request: Request,
	env: Env,
) {
	const url = new URL(request.url)
	const stateToken = url.searchParams.get('state')
	if (!stateToken) {
		return renderOAuthCallbackResponse(400, 'Missing OAuth state.')
	}

	let state: { draft_id: string; user_id: string; exp: number }
	try {
		state = await verifyToken(env, oauthStatePurpose, stateToken)
	} catch (error) {
		return renderOAuthCallbackResponse(
			400,
			error instanceof Error ? error.message : 'Invalid OAuth state.',
		)
	}

	const draft = await getConnectionDraftByIdUnsafe(env.APP_DB, state.draft_id)
	if (!draft || draft.user_id !== state.user_id) {
		return renderOAuthCallbackResponse(404, 'Connection draft not found.')
	}

	const providerError =
		url.searchParams.get('error_description') ?? url.searchParams.get('error')
	if (providerError) {
		await updateConnectionDraftUnsafe(env.APP_DB, draft.id, {
			status: 'error',
			error_message: providerError,
		})
		return renderOAuthCallbackResponse(400, providerError)
	}

	const code = url.searchParams.get('code')
	if (!code) {
		return renderOAuthCallbackResponse(
			400,
			'OAuth callback did not include a code.',
		)
	}

	const spec = parseConnectionAuthSpec(draft.auth_spec_json)
	if (
		spec.strategy !== 'oauth2_pre_registered_client' &&
		spec.strategy !== 'oauth2_dynamic_client'
	) {
		return renderOAuthCallbackResponse(
			400,
			'Connection draft is not configured for OAuth.',
		)
	}

	const stateJson = parseJsonRecord(draft.state_json)
	const redirectUri =
		typeof stateJson?.redirect_uri === 'string'
			? stateJson.redirect_uri
			: new URL('/api/connections/oauth/callback', url.origin).toString()
	const codeVerifier =
		typeof stateJson?.code_verifier === 'string'
			? stateJson.code_verifier
			: null
	const secretMaterial = await loadDraftSecretMaterial(env, draft.id)
	const tokenResponse = await exchangeOAuthCodeForTokens({
		env,
		spec,
		secretMaterial,
		code,
		redirectUri,
		codeVerifier,
	})

	for (const [name, value] of Object.entries(tokenResponse.secretMaterial)) {
		if (typeof value !== 'string') continue
		const encryptedValue = await encryptJson(
			env,
			encryptedDraftSecretPurpose,
			value,
		)
		await upsertConnectionDraftSecret(env.APP_DB, {
			draft_id: draft.id,
			secret_name: name,
			encrypted_value: encryptedValue,
		})
	}
	await updateConnectionDraftUnsafe(env.APP_DB, draft.id, {
		status: 'authorized',
		error_message: null,
		state_json: JSON.stringify({
			...(stateJson ?? {}),
			authorized_at: new Date().toISOString(),
		}),
	})
	return renderOAuthCallbackResponse(
		200,
		`${draft.display_name} authorization succeeded. Return to Kody and finish setup.`,
	)
}

async function exchangeOAuthCodeForTokens(input: {
	env: Env
	spec: Extract<
		ConnectionAuthSpec,
		{
			strategy: 'oauth2_pre_registered_client' | 'oauth2_dynamic_client'
		}
	>
	secretMaterial: DraftSecretMaterial
	code: string
	redirectUri: string
	codeVerifier: string | null
}) {
	const headers = new Headers({
		accept: 'application/json',
		'content-type': 'application/x-www-form-urlencoded',
	})
	const params = new URLSearchParams({
		grant_type: 'authorization_code',
		code: input.code,
		redirect_uri: input.redirectUri,
	})
	if (input.codeVerifier) {
		params.set('code_verifier', input.codeVerifier)
	}
	if (input.spec.token_auth_method === 'client_secret_basic') {
		const credentials = `${input.secretMaterial['client_id'] ?? ''}:${input.secretMaterial['client_secret'] ?? ''}`
		const encoded = base64UrlEncode(new TextEncoder().encode(credentials))
			.replaceAll('-', '+')
			.replaceAll('_', '/')
		headers.set('authorization', `Basic ${encoded}`)
	} else {
		params.set('client_id', input.secretMaterial['client_id'] ?? '')
		params.set('client_secret', input.secretMaterial['client_secret'] ?? '')
	}
	const response = await fetch(input.spec.token_url, {
		method: 'POST',
		headers,
		body: params,
	})
	const body = (await response.json().catch(() => null)) as unknown
	if (
		!response.ok ||
		!body ||
		typeof body !== 'object' ||
		Array.isArray(body)
	) {
		throw new Error(
			`OAuth token exchange failed (${response.status}). ${JSON.stringify(body)}`,
		)
	}
	const payload = body as Record<string, unknown>
	const secretMaterial = {
		...input.secretMaterial,
		access_token:
			typeof payload['access_token'] === 'string'
				? payload['access_token']
				: input.secretMaterial['access_token'],
		refresh_token:
			typeof payload['refresh_token'] === 'string'
				? payload['refresh_token']
				: input.secretMaterial['refresh_token'],
		token_type:
			typeof payload['token_type'] === 'string'
				? payload['token_type']
				: input.secretMaterial['token_type'],
		scope:
			typeof payload['scope'] === 'string'
				? payload['scope']
				: input.secretMaterial['scope'],
		expires_at:
			typeof payload['expires_in'] === 'number'
				? new Date(Date.now() + payload['expires_in'] * 1000).toISOString()
				: input.secretMaterial['expires_at'],
	}
	return { secretMaterial }
}

async function ensureDynamicClientRegistration(input: {
	env: Env
	draftId: string
	spec: Extract<ConnectionAuthSpec, { strategy: 'oauth2_dynamic_client' }>
	secretMaterial: DraftSecretMaterial
}) {
	if (input.secretMaterial['client_id']) {
		return input.secretMaterial
	}
	const response = await fetch(input.spec.registration_endpoint, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
		},
		body: JSON.stringify(input.spec.client_metadata),
	})
	const body = (await response.json().catch(() => null)) as unknown
	if (
		!response.ok ||
		!body ||
		typeof body !== 'object' ||
		Array.isArray(body)
	) {
		throw new Error(
			`Dynamic client registration failed (${response.status}). ${JSON.stringify(body)}`,
		)
	}
	const payload = body as Record<string, unknown>
	const nextSecretMaterial: DraftSecretMaterial = {
		...input.secretMaterial,
	}
	if (typeof payload['client_id'] === 'string') {
		nextSecretMaterial['client_id'] = payload['client_id']
	}
	if (typeof payload['client_secret'] === 'string') {
		nextSecretMaterial['client_secret'] = payload['client_secret']
	}
	for (const [name, value] of Object.entries(nextSecretMaterial)) {
		const encryptedValue = await encryptJson(
			input.env,
			encryptedDraftSecretPurpose,
			value,
		)
		await upsertConnectionDraftSecret(input.env.APP_DB, {
			draft_id: input.draftId,
			secret_name: name,
			encrypted_value: encryptedValue,
		})
	}
	return nextSecretMaterial
}

function getInitialDraftStatus(spec: ConnectionAuthSpec) {
	if (
		spec.strategy === 'oauth2_dynamic_client' &&
		spec.secret_fields.length === 0
	) {
		return 'ready_to_authorize'
	}
	if (spec.secret_fields.length === 0) {
		return spec.strategy.startsWith('oauth2_') ? 'ready_to_authorize' : 'draft'
	}
	return 'awaiting_secrets'
}

function getDraftStatusAfterSecrets(
	spec: ConnectionAuthSpec,
	secretMaterial: DraftSecretMaterial,
) {
	const missingSecretNames = getMissingSecretNames(spec, secretMaterial)
	if (missingSecretNames.length > 0) {
		return 'awaiting_secrets'
	}
	if (spec.strategy === 'manual_token' || spec.strategy === 'api_key') {
		return 'ready_to_finalize'
	}
	return 'ready_to_authorize'
}

function getMissingSecretNames(
	spec: ConnectionAuthSpec,
	secretMaterial: DraftSecretMaterial,
) {
	return getAuthSpecSecretFields(spec)
		.map((field) => field.name)
		.filter((name) => !secretMaterial[name])
}

function getMissingOAuthClientSecretNames(
	spec: Extract<
		ConnectionAuthSpec,
		{
			strategy: 'oauth2_pre_registered_client' | 'oauth2_dynamic_client'
		}
	>,
	secretMaterial: DraftSecretMaterial,
) {
	const requiredNames = ['client_id']
	if (
		spec.token_auth_method === 'client_secret_post' ||
		spec.token_auth_method === 'client_secret_basic' ||
		spec.strategy === 'oauth2_pre_registered_client'
	) {
		requiredNames.push('client_secret')
	}
	return requiredNames.filter((name) => !secretMaterial[name])
}

function getSetupInstructions(spec: ConnectionAuthSpec) {
	if (spec.strategy === 'manual_token' || spec.strategy === 'api_key') {
		return spec.instructions
	}
	return [
		'Collect any required OAuth client credentials first.',
		'Start the OAuth flow and complete it in the provider.',
	]
}

async function loadDraftSecretMaterial(env: Env, draftId: string) {
	const secretRows = await listConnectionDraftSecrets(env.APP_DB, draftId)
	const secretEntries = await Promise.all(
		secretRows.map(async (row) => {
			const value = await decryptJson<string>(
				env,
				encryptedDraftSecretPurpose,
				row.encrypted_value,
			)
			return [row.secret_name, value] as const
		}),
	)
	return Object.fromEntries(secretEntries) as DraftSecretMaterial
}

async function buildUniqueConnectionLabel(input: {
	env: Env
	userId: string
	providerKey: string
	preferredLabel: string
}) {
	const base = normalizeConnectionLabel(input.preferredLabel)
	const existingConnections = await listProviderConnectionsByProvider(
		input.env.APP_DB,
		input.userId,
		input.providerKey,
	)
	const existingLabels = new Set(
		existingConnections.map((connection) => connection.label),
	)
	if (!existingLabels.has(base)) {
		return base
	}
	let suffix = 2
	while (existingLabels.has(`${base}-${suffix}`)) {
		suffix += 1
	}
	return `${base}-${suffix}`
}

function normalizeConnectionLabel(label: string) {
	return label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

function verificationLabelFromBody(body: unknown) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	if (typeof record['login'] === 'string') return record['login']
	if (typeof record['name'] === 'string') return record['name']
	if (typeof record['email'] === 'string') return record['email']
	if (
		record['result'] &&
		typeof record['result'] === 'object' &&
		!Array.isArray(record['result'])
	) {
		const nested = record['result'] as Record<string, unknown>
		if (typeof nested['name'] === 'string') return nested['name']
		if (typeof nested['email'] === 'string') return nested['email']
	}
	return null
}

function parseScopeSet(scopeSet: string | null) {
	if (!scopeSet) return null
	try {
		const parsed = JSON.parse(scopeSet) as unknown
		if (!Array.isArray(parsed)) return null
		return parsed.filter((scope): scope is string => typeof scope === 'string')
	} catch {
		return null
	}
}

function pickConnection(
	connections: Array<
		Awaited<ReturnType<typeof listProviderConnectionsByProvider>>[number]
	>,
	selection: ConnectionSelection,
) {
	if (selection.strategy === 'id') {
		return connections.find(
			(connection) => connection.id === selection.connection_id,
		)
	}
	if (selection.strategy === 'label') {
		return connections.find(
			(connection) => connection.label === selection.label,
		)
	}
	if (connections.length === 1) return connections[0] ?? null
	return connections.find((connection) => connection.is_default === 1) ?? null
}

async function getRequiredConnectionDraft(
	env: Env,
	userId: string,
	draftId: string,
) {
	const draft = await getConnectionDraftById(env.APP_DB, userId, draftId)
	if (!draft) {
		throw new Error('Connection draft not found for this user.')
	}
	if (draft.expires_at && Date.parse(draft.expires_at) <= Date.now()) {
		throw new Error('Connection draft has expired.')
	}
	return draft
}

async function getRequiredProviderConnection(
	env: Env,
	userId: string,
	connectionId: string,
) {
	const connection = await getProviderConnectionById(
		env.APP_DB,
		userId,
		connectionId,
	)
	if (!connection) {
		throw new Error('Provider connection not found for this user.')
	}
	return connection
}

function parseJsonRecord(raw: string | null) {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		return parsed as Record<string, unknown>
	} catch {
		return null
	}
}

async function createPkceCodeChallenge(codeVerifier: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(codeVerifier),
	)
	return base64UrlEncode(new Uint8Array(digest))
}

function renderOAuthCallbackResponse(status: number, message: string) {
	return new Response(
		`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Connection Setup</title>
	</head>
	<body style="font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 24px;">
		<main style="max-width: 42rem;">
			<h1 style="margin-top: 0;">Connection Setup</h1>
			<p>${escapeHtml(message)}</p>
		</main>
	</body>
</html>`,
		{
			status,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
			},
		},
	)
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}
