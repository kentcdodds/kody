import {
	assertIntegrationHostAllowed,
	IntegrationHostNotAllowedError,
} from './integration-host-allowlist.ts'

export { IntegrationHostNotAllowedError }

type CapabilityResult = unknown
type SecretScope = 'session' | 'package' | 'user'

export type CapabilityArgs = Record<string, unknown>

export type KodyNamespace = Record<
	string,
	(args: CapabilityArgs) => Promise<CapabilityResult>
>

type IntegrationConfig = {
	name: string
	tokenUrl: string
	apiBaseUrl?: string | null
	flow: 'pkce' | 'confidential'
	clientIdValueName: string
	clientSecretSecretName?: string | null
	accessTokenSecretName: string
	refreshTokenSecretName?: string | null
	requiredHosts?: Array<string>
	authorization?: {
		authorizeUrl: string
		scopes: Array<string>
		scopeSeparator?: string | null
		extraAuthorizeParams?: Record<string, string>
	} | null
}

type IntegrationGetResult = {
	integration: IntegrationConfig | null
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

export type ExecuteRequestInput = string | URL | Request

export type BasicAuthSecretHeaderInput = {
	usernameSecret: string
	passwordSecret: string
	scope?: SecretScope | null
}

export type OAuthClientCredentialsInput = {
	tokenUrl: string | URL
	clientIdSecret: string
	clientSecretSecret: string
	scope?: SecretScope | null
	authStyle?: 'basic'
	body?: Record<string, string>
	headers?: Record<string, string>
}

export const secretHeaders = {
	basic(input: BasicAuthSecretHeaderInput) {
		return buildBasicAuthSecretPlaceholder({
			usernameSecret: normalizeSecretName(
				input.usernameSecret,
				'usernameSecret',
			),
			passwordSecret: normalizeSecretName(
				input.passwordSecret,
				'passwordSecret',
			),
			scope: normalizeOptionalSecretScope(input.scope),
		})
	},
}

export const EXECUTE_HELPER_CAPABILITY_NAMES = [
	'integration_get',
	'value_get',
	'secret_set',
] as const

/**
 * @internal
 * Refreshes and returns the raw OAuth access token for the named integration.
 *
 * **Security boundary**: The returned value is a materialized credential. Once
 * in caller hands, the fetch gateway's host-allowlist check is bypassed because
 * the gateway can only inspect secret *placeholders*. Callers that forward this
 * token in outbound requests MUST enforce the integration's host allowlist
 * themselves (see `assertIntegrationHostAllowed`). Prefer
 * `createAuthenticatedFetch` which performs this enforcement automatically.
 */
export async function refreshAccessToken(
	kody: KodyNamespace,
	providerName: string,
): Promise<string> {
	const integration = await readIntegrationConfig(kody, providerName)
	return refreshAccessTokenWithIntegration(kody, providerName, integration)
}

export async function createAuthenticatedFetch(
	kody: KodyNamespace,
	providerName: string,
): Promise<
	(input: ExecuteRequestInput, init?: RequestInit) => Promise<Response>
> {
	const integration = await readIntegrationConfig(kody, providerName)

	return async (input: ExecuteRequestInput, init?: RequestInit) => {
		const resolvedUrl = resolveRequestUrl(input, integration)
		assertIntegrationHostAllowed(providerName, integration, resolvedUrl)

		const request = new Request(resolvedUrl, init)
		const retryRequest: Request = request.clone() as Request
		let response: Response
		try {
			response = await fetch(
				createBearerRequest(
					request,
					buildAccessTokenAuthorizationHeader(providerName, integration),
				),
			)
		} catch (error) {
			if (!isMissingAccessTokenSecretError(error, integration)) throw error
			const refreshedAccessToken = await refreshAccessTokenWithIntegration(
				kody,
				providerName,
				integration,
			)
			return fetch(
				createBearerRequest(retryRequest, `Bearer ${refreshedAccessToken}`),
			)
		}
		if (response.status !== 401) return response

		await response.body?.cancel()
		const refreshedAccessToken = await refreshAccessTokenWithIntegration(
			kody,
			providerName,
			integration,
		)
		return fetch(
			createBearerRequest(retryRequest, `Bearer ${refreshedAccessToken}`),
		)
	}
}

export async function oauthClientCredentials(
	input: OAuthClientCredentialsInput,
): Promise<Record<string, unknown>> {
	const authStyle = (input.authStyle ?? 'basic') as string
	if (authStyle !== 'basic') {
		throw new Error(
			`Unsupported OAuth client_credentials authStyle "${authStyle}".`,
		)
	}
	const body = new URLSearchParams(input.body ?? {})
	body.set('grant_type', 'client_credentials')
	const headers = new Headers(input.headers)
	if (!headers.has('Accept')) {
		headers.set('Accept', 'application/json')
	}
	headers.set('Content-Type', 'application/x-www-form-urlencoded')
	headers.set(
		'Authorization',
		secretHeaders.basic({
			usernameSecret: input.clientIdSecret,
			passwordSecret: input.clientSecretSecret,
			scope: input.scope,
		}),
	)
	const response = await fetch(input.tokenUrl, {
		method: 'POST',
		headers,
		body: body.toString(),
	})
	const payload = (await response.json()) as unknown
	if (!response.ok) {
		throw new Error(
			`OAuth client_credentials request failed with HTTP ${response.status}.`,
		)
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new Error('OAuth client_credentials response was not a JSON object.')
	}
	return payload as Record<string, unknown>
}

async function readIntegrationConfig(
	kody: KodyNamespace,
	providerName: string,
) {
	const integrationGet = kody.integration_get
	if (typeof integrationGet !== 'function') {
		throw new Error('kody.integration_get is not available in this sandbox.')
	}
	const result = (await integrationGet({
		name: providerName,
	})) as IntegrationGetResult
	const integration = result?.integration ?? null
	if (!integration) {
		throw new Error(`Integration "${providerName}" was not found.`)
	}
	return integration
}

async function readClientId(
	kody: KodyNamespace,
	integration: IntegrationConfig,
) {
	const valueGet = kody.value_get
	if (typeof valueGet !== 'function') {
		throw new Error('kody.value_get is not available in this sandbox.')
	}
	const value = (await valueGet({
		name: integration.clientIdValueName,
	})) as ValueGetResult
	if (!value?.value) {
		throw new Error(
			`Client ID value "${integration.clientIdValueName}" was not found.`,
		)
	}
	return value.value
}

async function persistSecret(
	kody: KodyNamespace,
	providerName: string,
	secretName: string,
	secretKind: 'access token' | 'refresh token',
	value: string,
) {
	const secretSet = kody.secret_set
	if (typeof secretSet !== 'function') {
		throw new Error('kody.secret_set is not available in this sandbox.')
	}
	const normalizedSecretName = secretName.trim()
	if (!normalizedSecretName) {
		throw new Error(
			`Integration "${providerName}" does not define an ${secretKind} secret name.`,
		)
	}
	await secretSet({
		name: normalizedSecretName,
		value,
		scope: 'user',
	})
}

async function refreshAccessTokenWithIntegration(
	kody: KodyNamespace,
	providerName: string,
	integration: IntegrationConfig,
) {
	const clientId = await readClientId(kody, integration)
	const refreshTokenSecretName =
		integration.refreshTokenSecretName?.trim() ?? ''
	if (!refreshTokenSecretName) {
		throw new Error(
			`Integration "${providerName}" does not define a refresh token secret name.`,
		)
	}

	const params = new URLSearchParams()
	params.set('grant_type', 'refresh_token')
	params.set(
		'refresh_token',
		buildSecretPlaceholder(refreshTokenSecretName, 'user'),
	)
	params.set('client_id', clientId)

	if (integration.flow === 'confidential') {
		const clientSecretSecretName =
			integration.clientSecretSecretName?.trim() ?? ''
		if (!clientSecretSecretName) {
			throw new Error(
				`Integration "${providerName}" uses confidential flow but does not define a client secret secret name.`,
			)
		}
		params.set(
			'client_secret',
			buildSecretPlaceholder(clientSecretSecretName, 'user'),
		)
	}

	const response = await fetch(integration.tokenUrl, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: params.toString(),
	})
	const payload = (await response.json()) as Record<string, unknown>

	if (!response.ok) {
		throw new Error(
			`Token refresh failed for integration "${providerName}" with HTTP ${response.status}.`,
		)
	}
	if (!payload || typeof payload.access_token !== 'string') {
		throw new Error(
			`Token refresh for integration "${providerName}" did not return an access_token.`,
		)
	}

	if (
		typeof payload.refresh_token === 'string' &&
		payload.refresh_token.length > 0
	) {
		await persistSecret(
			kody,
			providerName,
			refreshTokenSecretName,
			'refresh token',
			payload.refresh_token,
		)
	}
	await persistSecret(
		kody,
		providerName,
		integration.accessTokenSecretName,
		'access token',
		payload.access_token,
	)

	return payload.access_token
}

function buildSecretPlaceholder(name: string, scope: SecretScope) {
	return `{{secret:${name}|scope=${scope}}}`
}

function buildAccessTokenAuthorizationHeader(
	providerName: string,
	integration: IntegrationConfig,
) {
	const accessTokenSecretName = integration.accessTokenSecretName.trim()
	if (!accessTokenSecretName) {
		throw new Error(
			`Integration "${providerName}" does not define an access token secret name.`,
		)
	}
	return `Bearer ${buildSecretPlaceholder(accessTokenSecretName, 'user')}`
}

function createBearerRequest(request: Request, authorization: string) {
	const headers = new Headers(request.headers)
	headers.set('Authorization', authorization)
	return new Request(request, { headers })
}

function isMissingAccessTokenSecretError(
	error: unknown,
	integration: IntegrationConfig,
) {
	const accessTokenSecretName = integration.accessTokenSecretName.trim()
	return (
		error instanceof Error &&
		accessTokenSecretName.length > 0 &&
		error.message === `Secret "${accessTokenSecretName}" was not found.`
	)
}

function buildBasicAuthSecretPlaceholder(input: {
	usernameSecret: string
	passwordSecret: string
	scope?: SecretScope | null
}) {
	return input.scope
		? `{{secret-basic:username=${input.usernameSecret},password=${input.passwordSecret}|scope=${input.scope}}}`
		: `{{secret-basic:username=${input.usernameSecret},password=${input.passwordSecret}}}`
}

function normalizeSecretName(value: string, fieldName: string) {
	const normalized = value.trim()
	if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
		throw new Error(
			`${fieldName} must be a saved secret name using letters, numbers, dots, underscores, or hyphens.`,
		)
	}
	return normalized
}

function normalizeOptionalSecretScope(scope: SecretScope | null | undefined) {
	if (scope == null) return null
	if (scope === 'package' || scope === 'session' || scope === 'user')
		return scope
	throw new Error(`Unsupported secret scope "${scope}".`)
}

function resolveRequestUrl(
	input: ExecuteRequestInput,
	integration: IntegrationConfig,
) {
	if (typeof input === 'string' && input.startsWith('/')) {
		return resolveRelativeUrl(input, integration)
	}
	if (input instanceof URL) return input
	if (typeof input === 'string') return input
	if (input instanceof Request) {
		const relativePath = getRelativePathFromRequest(input, integration)
		if (relativePath) {
			return new Request(resolveRelativeUrl(relativePath, integration), input)
		}
	}
	return input
}

function getRelativePathFromRequest(
	input: Request,
	integration: IntegrationConfig,
): string | null {
	const requestUrl = new URL(input.url)
	const normalizedBase = getNormalizedApiBaseUrl(integration)
	if (normalizedBase && requestUrl.href.startsWith(normalizedBase)) {
		return null
	}
	const runtimeOrigin = getRuntimeOrigin()
	if (!runtimeOrigin || requestUrl.origin !== runtimeOrigin) {
		return null
	}
	return `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`
}

function getRuntimeOrigin() {
	const runtimeLocation = (
		globalThis as typeof globalThis & {
			location?: { origin?: string | null }
		}
	).location
	const origin = runtimeLocation?.origin ?? null
	return typeof origin === 'string' && origin.length > 0 ? origin : null
}

function getNormalizedApiBaseUrl(integration: IntegrationConfig) {
	if (!integration.apiBaseUrl) return null
	return integration.apiBaseUrl.endsWith('/')
		? integration.apiBaseUrl.slice(0, -1)
		: integration.apiBaseUrl
}

function resolveRelativeUrl(pathname: string, integration: IntegrationConfig) {
	const normalizedBase = getNormalizedApiBaseUrl(integration)
	if (!normalizedBase) {
		throw new Error(
			`Integration "${integration.name}" does not define apiBaseUrl for relative requests.`,
		)
	}
	return new URL(`${normalizedBase}${pathname}`)
}

export function getExecuteHelperCapabilityNames() {
	return [...EXECUTE_HELPER_CAPABILITY_NAMES]
}

export function createExecuteHelperPrelude() {
	return `
class IntegrationHostNotAllowedError extends Error {
  constructor(integrationName, disallowedHost) {
    super(
      \`Integration "\${integrationName}" does not allow requests to host "\${disallowedHost}". \` +
        \`The host must be listed in the integration's requiredHosts or match its apiBaseUrl.\`
    );
    this.name = 'IntegrationHostNotAllowedError';
    this.integrationName = integrationName;
    this.disallowedHost = disallowedHost;
  }
}
const __kodyGetIntegrationAllowedHosts = (integration) => {
  const hosts = new Set();
  if (integration.requiredHosts) {
    for (const host of integration.requiredHosts) {
      const normalized = host.trim().toLowerCase();
      if (normalized) hosts.add(normalized);
    }
  }
  if (integration.apiBaseUrl) {
    const apiHost = new URL(integration.apiBaseUrl).hostname.trim().toLowerCase();
    if (apiHost) hosts.add(apiHost);
  }
  return Array.from(hosts);
};
const __kodyAssertIntegrationHostAllowed = (integrationName, integration, url) => {
  let resolvedUrl;
  if (typeof url === 'string') {
    if (url.startsWith('//')) {
      resolvedUrl = \`https:\${url}\`;
    } else if (url.startsWith('/')) {
      return;
    } else {
      resolvedUrl = url;
    }
  } else if (url instanceof URL) {
    resolvedUrl = url.href;
  } else if (url instanceof Request) {
    resolvedUrl = url.url;
  } else {
    return;
  }
  let requestHost;
  try {
    requestHost = new URL(resolvedUrl).hostname.trim().toLowerCase();
  } catch {
    return;
  }
  if (!requestHost) return;
  const allowedHosts = __kodyGetIntegrationAllowedHosts(integration);
  if (allowedHosts.length === 0) {
    throw new Error(
      \`Integration "\${integrationName}" has no allowed hosts configured (requiredHosts and apiBaseUrl are both empty). \` +
        \`Cannot attach credentials without a host allowlist.\`
    );
  }
  if (!allowedHosts.includes(requestHost)) {
    throw new IntegrationHostNotAllowedError(integrationName, requestHost);
  }
};
const __kodyBuildSecretPlaceholder = (name, scope) =>
  \`{{secret:\${name}|scope=\${scope}}}\`;
const __kodyBuildAccessTokenAuthorizationHeader = (providerName, integration) => {
  const accessTokenSecretName = integration.accessTokenSecretName.trim();
  if (!accessTokenSecretName) {
    throw new Error(
      \`Integration "\${providerName}" does not define an access token secret name.\`,
    );
  }
  return \`Bearer \${__kodyBuildSecretPlaceholder(accessTokenSecretName, 'user')}\`;
};
const __kodyCreateBearerRequest = (request, authorization) => {
  const headers = new Headers(request.headers);
  headers.set('Authorization', authorization);
  return new Request(request, { headers });
};
const __kodyIsMissingAccessTokenSecretError = (error, integration) => {
  const accessTokenSecretName = integration.accessTokenSecretName.trim();
  return (
    error instanceof Error &&
    accessTokenSecretName.length > 0 &&
    error.message === \`Secret "\${accessTokenSecretName}" was not found.\`
  );
};
const __kodyNormalizeSecretName = (value, fieldName) => {
  const normalized = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new Error(
      \`\${fieldName} must be a saved secret name using letters, numbers, dots, underscores, or hyphens.\`,
    );
  }
  return normalized;
};
const __kodyNormalizeOptionalSecretScope = (scope) => {
  if (scope == null) return null;
  if (scope === 'package' || scope === 'session' || scope === 'user') return scope;
  throw new Error(\`Unsupported secret scope "\${scope}".\`);
};
const __kodyBuildBasicAuthSecretPlaceholder = (input) => {
  const usernameSecret = __kodyNormalizeSecretName(input.usernameSecret, 'usernameSecret');
  const passwordSecret = __kodyNormalizeSecretName(input.passwordSecret, 'passwordSecret');
  const scope = __kodyNormalizeOptionalSecretScope(input.scope);
  return scope
    ? \`{{secret-basic:username=\${usernameSecret},password=\${passwordSecret}|scope=\${scope}}}\`
    : \`{{secret-basic:username=\${usernameSecret},password=\${passwordSecret}}}\`;
};
const secretHeaders = {
  basic(input) {
    return __kodyBuildBasicAuthSecretPlaceholder(input);
  },
};
const __kodyReadIntegrationConfig = async (providerName) => {
  const integrationGet = kody.integration_get;
  if (typeof integrationGet !== 'function') {
    throw new Error('kody.integration_get is not available in this sandbox.');
  }
  const result = await integrationGet({ name: providerName });
  const integration = result?.integration ?? null;
  if (!integration) {
    throw new Error(\`Integration "\${providerName}" was not found.\`);
  }
  return integration;
};
const __kodyReadClientId = async (integration) => {
  const valueGet = kody.value_get;
  if (typeof valueGet !== 'function') {
    throw new Error('kody.value_get is not available in this sandbox.');
  }
  const value = await valueGet({ name: integration.clientIdValueName });
  if (!value?.value) {
    throw new Error(
      \`Client ID value "\${integration.clientIdValueName}" was not found.\`,
    );
  }
  return value.value;
};
const __kodyPersistSecret = async (
  providerName,
  secretName,
  secretKind,
  value,
) => {
  const secretSet = kody.secret_set;
  if (typeof secretSet !== 'function') {
    throw new Error('kody.secret_set is not available in this sandbox.');
  }
  const normalizedSecretName = secretName.trim();
  if (!normalizedSecretName) {
    throw new Error(
      \`Integration "\${providerName}" does not define an \${secretKind} secret name.\`,
    );
  }
  await secretSet({
    name: normalizedSecretName,
    value,
    scope: 'user',
  });
};
const __kodyGetNormalizedApiBaseUrl = (integration) => {
  if (!integration.apiBaseUrl) return null;
  return integration.apiBaseUrl.endsWith('/')
    ? integration.apiBaseUrl.slice(0, -1)
    : integration.apiBaseUrl;
};
const __kodyGetRuntimeOrigin = () => {
  const origin = globalThis.location?.origin ?? null;
  return typeof origin === 'string' && origin.length > 0 ? origin : null;
};
const __kodyResolveRelativeUrl = (pathname, integration) => {
  const normalizedBase = __kodyGetNormalizedApiBaseUrl(integration);
  if (!normalizedBase) {
    throw new Error(
      \`Integration "\${integration.name}" does not define apiBaseUrl for relative requests.\`,
    );
  }
  return new URL(\`\${normalizedBase}\${pathname}\`);
};
const __kodyGetRelativePathFromRequest = (input, integration) => {
  const requestUrl = new URL(input.url);
  const normalizedBase = __kodyGetNormalizedApiBaseUrl(integration);
  if (normalizedBase && requestUrl.href.startsWith(normalizedBase)) {
    return null;
  }
  const runtimeOrigin = __kodyGetRuntimeOrigin();
  if (!runtimeOrigin || requestUrl.origin !== runtimeOrigin) {
    return null;
  }
  return \`\${requestUrl.pathname}\${requestUrl.search}\${requestUrl.hash}\`;
};
const __kodyResolveRequestUrl = (input, integration) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    return __kodyResolveRelativeUrl(input, integration);
  }
  if (input instanceof URL) return input;
  if (typeof input === 'string') return input;
  if (input instanceof Request) {
    const relativePath = __kodyGetRelativePathFromRequest(input, integration);
    if (relativePath) {
      return new Request(__kodyResolveRelativeUrl(relativePath, integration), input);
    }
  }
  return input;
};
const __kodyRefreshAccessToken = async (providerName) => {
  const integration = await __kodyReadIntegrationConfig(providerName);
  const clientId = await __kodyReadClientId(integration);
  const refreshTokenSecretName = integration.refreshTokenSecretName?.trim() ?? '';
  if (!refreshTokenSecretName) {
    throw new Error(
      \`Integration "\${providerName}" does not define a refresh token secret name.\`,
    );
  }
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set(
    'refresh_token',
    __kodyBuildSecretPlaceholder(refreshTokenSecretName, 'user'),
  );
  params.set('client_id', clientId);
  if (integration.flow === 'confidential') {
    const clientSecretSecretName = integration.clientSecretSecretName?.trim() ?? '';
    if (!clientSecretSecretName) {
      throw new Error(
        \`Integration "\${providerName}" uses confidential flow but does not define a client secret secret name.\`,
      );
    }
    params.set(
      'client_secret',
      __kodyBuildSecretPlaceholder(clientSecretSecretName, 'user'),
    );
  }
  const response = await fetch(integration.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      \`Token refresh failed for integration "\${providerName}" with HTTP \${response.status}.\`,
    );
  }
  if (!payload || typeof payload.access_token !== 'string') {
    throw new Error(
      \`Token refresh for integration "\${providerName}" did not return an access_token.\`,
    );
  }
  if (typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0) {
    await __kodyPersistSecret(
      providerName,
      refreshTokenSecretName,
      'refresh token',
      payload.refresh_token,
    );
  }
  await __kodyPersistSecret(
    providerName,
    integration.accessTokenSecretName,
    'access token',
    payload.access_token,
  );
  return payload.access_token;
};
const __kodyCreateAuthenticatedFetch = async (providerName) => {
  const integration = await __kodyReadIntegrationConfig(providerName);
  return async (input, init) => {
    const resolvedUrl = __kodyResolveRequestUrl(input, integration);
    __kodyAssertIntegrationHostAllowed(providerName, integration, resolvedUrl);
    const request = new Request(resolvedUrl, init);
    const retryRequest = request.clone();
    let response;
    try {
      response = await fetch(
        __kodyCreateBearerRequest(
          request,
          __kodyBuildAccessTokenAuthorizationHeader(providerName, integration),
        ),
      );
    } catch (error) {
      if (!__kodyIsMissingAccessTokenSecretError(error, integration)) throw error;
      const refreshedAccessToken = await __kodyRefreshAccessToken(providerName);
      return fetch(
        __kodyCreateBearerRequest(retryRequest, \`Bearer \${refreshedAccessToken}\`),
      );
    }
    if (response.status !== 401) return response;
    await response.body?.cancel();
    const refreshedAccessToken = await __kodyRefreshAccessToken(providerName);
    return fetch(
      __kodyCreateBearerRequest(retryRequest, \`Bearer \${refreshedAccessToken}\`),
    );
  };
};
const __kodyOauthClientCredentials = async (input) => {
  const authStyle = input.authStyle ?? 'basic';
  if (authStyle !== 'basic') {
    throw new Error(\`Unsupported OAuth client_credentials authStyle "\${authStyle}".\`);
  }
  const body = new URLSearchParams(input.body ?? {});
  body.set('grant_type', 'client_credentials');
  const headers = new Headers(input.headers);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  headers.set('Content-Type', 'application/x-www-form-urlencoded');
  headers.set(
    'Authorization',
    secretHeaders.basic({
      usernameSecret: input.clientIdSecret,
      passwordSecret: input.clientSecretSecret,
      scope: input.scope,
    }),
  );
  const response = await fetch(input.tokenUrl, {
    method: 'POST',
    headers,
    body: body.toString(),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(
      \`OAuth client_credentials request failed with HTTP \${response.status}.\`,
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('OAuth client_credentials response was not a JSON object.');
  }
  return payload;
};
const refreshAccessToken = async (providerName) =>
  __kodyRefreshAccessToken(providerName);
const createAuthenticatedFetch = async (providerName) =>
  __kodyCreateAuthenticatedFetch(providerName);
const oauthClientCredentials = async (input) =>
  __kodyOauthClientCredentials(input);
`.trim()
}
