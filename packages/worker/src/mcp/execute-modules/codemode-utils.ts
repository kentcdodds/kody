type CapabilityResult = unknown

type CapabilityArgs = Record<string, unknown>

type CodemodeNamespace = Record<
	string,
	(args: CapabilityArgs) => Promise<CapabilityResult>
>

type ConnectorConfig = {
	name: string
	tokenUrl: string
	apiBaseUrl?: string | null
	flow: 'pkce' | 'confidential'
	clientIdValueName: string
	clientSecretSecretName?: string | null
	accessTokenSecretName: string
	refreshTokenSecretName?: string | null
	requiredHosts?: Array<string>
}

type ConnectorGetResult = {
	connector: ConnectorConfig | null
}

type ValueGetResult = {
	name: string
	scope: string
	value: string
	description: string
	app_id: string | null
	created_at: string
	updated_at: string
	ttl_ms: number | null
} | null

export function createCodemodeUtils(codemode: CodemodeNamespace) {
	return {
		createAuthenticatedFetch(providerName: string) {
			return createAuthenticatedFetch(codemode, providerName)
		},
		refreshAccessToken(providerName: string) {
			return refreshAccessToken(codemode, providerName)
		},
	}
}

export async function refreshAccessToken(
	codemode: CodemodeNamespace,
	providerName: string,
) {
	const connector = await readConnectorConfig(codemode, providerName)
	const clientId = await readClientId(codemode, connector)
	const refreshTokenSecretName = connector.refreshTokenSecretName?.trim() ?? ''
	if (!refreshTokenSecretName) {
		throw new Error(
			`Connector "${providerName}" does not define a refresh token secret name.`,
		)
	}

	const params = new URLSearchParams()
	params.set('grant_type', 'refresh_token')
	params.set(
		'refresh_token',
		buildSecretPlaceholder(refreshTokenSecretName, 'user'),
	)
	params.set('client_id', clientId)

	if (connector.flow === 'confidential') {
		const clientSecretSecretName = connector.clientSecretSecretName?.trim() ?? ''
		if (!clientSecretSecretName) {
			throw new Error(
				`Connector "${providerName}" uses confidential flow but does not define a client secret secret name.`,
			)
		}
		params.set(
			'client_secret',
			buildSecretPlaceholder(clientSecretSecretName, 'user'),
		)
	}

	const response = await fetch(connector.tokenUrl, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: params.toString(),
	})
	const payload = (await response.json().catch(() => null)) as
		| Record<string, unknown>
		| null

	if (!response.ok) {
		throw new Error(
			`Token refresh failed for connector "${providerName}" with HTTP ${response.status}.`,
		)
	}
	if (!payload || typeof payload.access_token !== 'string') {
		throw new Error(
			`Token refresh for connector "${providerName}" did not return an access_token.`,
		)
	}

	return payload.access_token
}

export async function createAuthenticatedFetch(
	codemode: CodemodeNamespace,
	providerName: string,
) {
	const connector = await readConnectorConfig(codemode, providerName)
	const accessToken = await refreshAccessToken(codemode, providerName)

	return async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(resolveRequestUrl(input, connector), init)
		const headers = new Headers(request.headers)
		headers.set('Authorization', `Bearer ${accessToken}`)

		return fetch(
			new Request(request, {
				headers,
			}),
		)
	}
}

async function readConnectorConfig(
	codemode: CodemodeNamespace,
	providerName: string,
) {
	const result = (await codemode.connector_get({
		name: providerName,
	})) as ConnectorGetResult
	const connector = result?.connector ?? null
	if (!connector) {
		throw new Error(`Connector "${providerName}" was not found.`)
	}
	return connector
}

async function readClientId(
	codemode: CodemodeNamespace,
	connector: ConnectorConfig,
) {
	const value = (await codemode.value_get({
		name: connector.clientIdValueName,
	})) as ValueGetResult
	if (!value?.value) {
		throw new Error(
			`Client ID value "${connector.clientIdValueName}" was not found.`,
		)
	}
	return value.value
}

function buildSecretPlaceholder(name: string, scope: 'user' | 'app' | 'session') {
	return `{{secret:${name}|scope=${scope}}}`
}

function resolveRequestUrl(input: RequestInfo | URL, connector: ConnectorConfig) {
	if (typeof input === 'string' && input.startsWith('/')) {
		return resolveRelativeUrl(input, connector)
	}
	if (input instanceof URL) return input
	if (typeof input === 'string') return input
	if (input instanceof Request && input.url.startsWith('/')) {
		return new Request(
			resolveRelativeUrl(input.url, connector),
			input,
		)
	}
	return input
}

function resolveRelativeUrl(pathname: string, connector: ConnectorConfig) {
	if (!connector.apiBaseUrl) {
		throw new Error(
			`Connector "${connector.name}" does not define apiBaseUrl for relative requests.`,
		)
	}
	const normalizedBase = connector.apiBaseUrl.endsWith('/')
		? connector.apiBaseUrl.slice(0, -1)
		: connector.apiBaseUrl
	return new URL(`${normalizedBase}${pathname}`)
}
