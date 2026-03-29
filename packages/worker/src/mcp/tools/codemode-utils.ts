export const codemodeUtilsModuleSpecifier = '@kody/codemode-utils' as const

export function buildCodemodeUtilsModuleSource() {
	return `
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireCodemode() {
	const providers = globalThis.__kodyProviders
	const codemode = providers && typeof providers === 'object' ? providers.codemode : globalThis.codemode
	if (!codemode || typeof codemode !== 'object') {
		throw new Error('@kody/codemode-utils requires the codemode provider.')
	}
	return codemode
}

function buildConnectorValueName(name) {
	return '_connector:' + name
}

function normalizeOptionalName(value) {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeConnectorConfig(value, fallbackName) {
	if (!isRecord(value)) return null
	const name =
		typeof value.name === 'string' && value.name.trim().length > 0
			? value.name.trim()
			: typeof fallbackName === 'string' && fallbackName.trim().length > 0
				? fallbackName.trim()
				: null
	const flow = value.flow === 'pkce' || value.flow === 'confidential' ? value.flow : null
	const tokenUrl =
		typeof value.tokenUrl === 'string' && value.tokenUrl.trim().length > 0
			? value.tokenUrl.trim()
			: null
	const clientIdValueName =
		typeof value.clientIdValueName === 'string' &&
		value.clientIdValueName.trim().length > 0
			? value.clientIdValueName.trim()
			: null
	const accessTokenSecretName =
		typeof value.accessTokenSecretName === 'string' &&
		value.accessTokenSecretName.trim().length > 0
			? value.accessTokenSecretName.trim()
			: null
	if (!name || !flow || !tokenUrl || !clientIdValueName || !accessTokenSecretName) {
		return null
	}
	return {
		name,
		tokenUrl,
		flow,
		clientIdValueName,
		clientSecretSecretName: normalizeOptionalName(value.clientSecretSecretName),
		accessTokenSecretName,
		refreshTokenSecretName: normalizeOptionalName(value.refreshTokenSecretName),
		requiredHosts: Array.isArray(value.requiredHosts)
			? value.requiredHosts.filter((entry) => typeof entry === 'string')
			: [],
	}
}

async function readConnectorConfig(providerName) {
	if (typeof providerName !== 'string' || providerName.trim().length === 0) {
		throw new Error('Provider name is required.')
	}
	const normalizedProviderName = providerName.trim()
	const codemode = requireCodemode()
	if (typeof codemode.connector_get === 'function') {
		const result = await codemode.connector_get({ name: normalizedProviderName })
		const connector = isRecord(result) ? result.connector : null
		const parsed = normalizeConnectorConfig(connector, normalizedProviderName)
		if (parsed) {
			return parsed
		}
	}
	if (typeof codemode.value_get !== 'function') {
		throw new Error(
			'@kody/codemode-utils requires codemode.value_get when connector_get is unavailable.',
		)
	}
	const storedValue = await codemode.value_get({
		name: buildConnectorValueName(normalizedProviderName),
		scope: 'user',
	})
	if (!isRecord(storedValue) || typeof storedValue.value !== 'string') {
		throw new Error('Connector "' + normalizedProviderName + '" is not configured.')
	}
	let parsedJson = null
	try {
		parsedJson = JSON.parse(storedValue.value)
	} catch {
		throw new Error(
			'Connector "' + normalizedProviderName + '" has invalid JSON config.',
		)
	}
	const parsed = normalizeConnectorConfig(parsedJson, normalizedProviderName)
	if (!parsed) {
		throw new Error(
			'Connector "' + normalizedProviderName + '" has invalid config.',
		)
	}
	return parsed
}

async function readRequiredValue(name) {
	const codemode = requireCodemode()
	if (typeof codemode.value_get !== 'function') {
		throw new Error('@kody/codemode-utils requires codemode.value_get.')
	}
	const value = await codemode.value_get({ name })
	if (!isRecord(value) || typeof value.value !== 'string' || value.value.length === 0) {
		throw new Error('Value "' + name + '" is not configured.')
	}
	return value.value
}

function buildSecretPlaceholder(name) {
	return '{{secret:' + name + '}}'
}

function encodeFormComponent(value) {
	return typeof value === 'string' &&
		value.startsWith('{{secret:') &&
		value.endsWith('}}')
		? value
		: encodeURIComponent(String(value))
}

function buildFormBody(entries) {
	return entries
		.filter((entry) => entry[1] != null && String(entry[1]).length > 0)
		.map(
			([key, value]) =>
				encodeURIComponent(String(key)) + '=' + encodeFormComponent(value),
		)
		.join('&')
}

async function parseTokenResponse(response) {
	const text = await response.text()
	let data = null
	const contentType = response.headers.get('content-type') || ''
	if (
		text &&
		(/\\bjson\\b/i.test(contentType) ||
			text.startsWith('{') ||
			text.startsWith('['))
	) {
		try {
			data = JSON.parse(text)
		} catch {}
	}
	return { text, data }
}

function getTokenRefreshErrorMessage(providerName, response, payload) {
	if (isRecord(payload)) {
		if (
			typeof payload.error_description === 'string' &&
			payload.error_description.length > 0
		) {
			return payload.error_description
		}
		if (typeof payload.error === 'string' && payload.error.length > 0) {
			return payload.error
		}
	}
	return (
		payload.text ||
		'Token refresh for "' +
			providerName +
			'" failed with HTTP status ' +
			response.status +
			'.'
	)
}

export async function refreshAccessToken(providerName) {
	const connector = await readConnectorConfig(providerName)
	if (!connector.refreshTokenSecretName) {
		throw new Error(
			'Connector "' + connector.name + '" is missing refreshTokenSecretName.',
		)
	}
	const clientId = await readRequiredValue(connector.clientIdValueName)
	const body = buildFormBody([
		['grant_type', 'refresh_token'],
		['client_id', clientId],
		['refresh_token', buildSecretPlaceholder(connector.refreshTokenSecretName)],
		...(connector.flow === 'confidential' && connector.clientSecretSecretName
			? [
					[
						'client_secret',
						buildSecretPlaceholder(connector.clientSecretSecretName),
					],
				]
			: []),
	])
	const response = await fetch(connector.tokenUrl, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
	})
	const payload = await parseTokenResponse(response)
	if (!response.ok) {
		throw new Error(
			getTokenRefreshErrorMessage(connector.name, response, payload),
		)
	}
	const accessToken =
		isRecord(payload.data) && typeof payload.data.access_token === 'string'
			? payload.data.access_token
			: null
	if (!accessToken) {
		throw new Error(
			'Token refresh for "' +
				connector.name +
				'" did not return an access_token.',
		)
	}
	return accessToken
}

export async function createAuthenticatedFetch(providerName) {
	const accessToken = await refreshAccessToken(providerName)
	return async function authenticatedFetch(input, init) {
		const request = new Request(input, init)
		const headers = new Headers(request.headers)
		headers.set('Authorization', 'Bearer ' + accessToken)
		return fetch(new Request(request, { headers }))
	}
}
`.trim()
}
