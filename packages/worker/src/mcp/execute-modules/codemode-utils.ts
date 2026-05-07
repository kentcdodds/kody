import {
	assertIntegrationHostAllowed,
	IntegrationHostNotAllowedError,
} from './integration-host-allowlist.ts'

export { IntegrationHostNotAllowedError }

type CapabilityResult = unknown

export type CapabilityArgs = Record<string, unknown>

export type CodemodeNamespace = Record<
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

export const EXECUTE_HELPER_CAPABILITY_NAMES = [
	'integration_get',
	'value_get',
	'secret_set',
	'agent_turn_start',
	'agent_turn_next',
	'agent_turn_cancel',
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
	codemode: CodemodeNamespace,
	providerName: string,
): Promise<string> {
	const integration = await readIntegrationConfig(codemode, providerName)
	return refreshAccessTokenWithIntegration(codemode, providerName, integration)
}

export async function createAuthenticatedFetch(
	codemode: CodemodeNamespace,
	providerName: string,
): Promise<
	(input: ExecuteRequestInput, init?: RequestInit) => Promise<Response>
> {
	const integration = await readIntegrationConfig(codemode, providerName)
	const accessToken = await refreshAccessTokenWithIntegration(
		codemode,
		providerName,
		integration,
	)

	return async (input: ExecuteRequestInput, init?: RequestInit) => {
		const resolvedUrl = resolveRequestUrl(input, integration)
		assertIntegrationHostAllowed(providerName, integration, resolvedUrl)

		const request = new Request(resolvedUrl, init)
		const headers = new Headers(request.headers)
		headers.set('Authorization', `Bearer ${accessToken}`)

		return fetch(
			new Request(request, {
				headers,
			}),
		)
	}
}

async function readIntegrationConfig(
	codemode: CodemodeNamespace,
	providerName: string,
) {
	const integrationGet = codemode.integration_get
	if (typeof integrationGet !== 'function') {
		throw new Error(
			'codemode.integration_get is not available in this sandbox.',
		)
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
	codemode: CodemodeNamespace,
	integration: IntegrationConfig,
) {
	const valueGet = codemode.value_get
	if (typeof valueGet !== 'function') {
		throw new Error('codemode.value_get is not available in this sandbox.')
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
	codemode: CodemodeNamespace,
	providerName: string,
	secretName: string,
	secretKind: 'access token' | 'refresh token',
	value: string,
) {
	const secretSet = codemode.secret_set
	if (typeof secretSet !== 'function') {
		throw new Error('codemode.secret_set is not available in this sandbox.')
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
	codemode: CodemodeNamespace,
	providerName: string,
	integration: IntegrationConfig,
) {
	const clientId = await readClientId(codemode, integration)
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
	const payload = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null

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
			codemode,
			providerName,
			refreshTokenSecretName,
			'refresh token',
			payload.refresh_token,
		)
	}
	await persistSecret(
		codemode,
		providerName,
		integration.accessTokenSecretName,
		'access token',
		payload.access_token,
	)

	return payload.access_token
}

function buildSecretPlaceholder(
	name: string,
	scope: 'user' | 'app' | 'session',
) {
	return `{{secret:${name}|scope=${scope}}}`
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
    try {
      const apiHost = new URL(integration.apiBaseUrl).hostname.trim().toLowerCase();
      if (apiHost) hosts.add(apiHost);
    } catch {}
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
const __kodyReadIntegrationConfig = async (providerName) => {
  const integrationGet = codemode.integration_get;
  if (typeof integrationGet !== 'function') {
    throw new Error('codemode.integration_get is not available in this sandbox.');
  }
  const result = await integrationGet({ name: providerName });
  const integration = result?.integration ?? null;
  if (!integration) {
    throw new Error(\`Integration "\${providerName}" was not found.\`);
  }
  return integration;
};
const __kodyReadClientId = async (integration) => {
  const valueGet = codemode.value_get;
  if (typeof valueGet !== 'function') {
    throw new Error('codemode.value_get is not available in this sandbox.');
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
  const secretSet = codemode.secret_set;
  if (typeof secretSet !== 'function') {
    throw new Error('codemode.secret_set is not available in this sandbox.');
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
  const payload = await response.json().catch(() => null);
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
  const accessToken = await __kodyRefreshAccessToken(providerName);
  return async (input, init) => {
    const resolvedUrl = __kodyResolveRequestUrl(input, integration);
    __kodyAssertIntegrationHostAllowed(providerName, integration, resolvedUrl);
    const request = new Request(resolvedUrl, init);
    const headers = new Headers(request.headers);
    headers.set('Authorization', \`Bearer \${accessToken}\`);
    return fetch(
      new Request(request, {
        headers,
      }),
    );
  };
};
const __kodyAgentChatTurnStream = async function* (input) {
  const start = await codemode.agent_turn_start(input);
  if (!start || !start.ok || !start.runId || !start.sessionId) {
    throw new Error('agent_turn_start did not return a valid run id and session id.');
  }
  let cursor = 0;
  let done = false;
  try {
    while (!done) {
      const next = await codemode.agent_turn_next({
        sessionId: start.sessionId,
        runId: start.runId,
        cursor,
      });
      const events = Array.isArray(next?.events) ? next.events : [];
      cursor = typeof next?.nextCursor === 'number' ? next.nextCursor : cursor;
      for (const event of events) {
        yield event;
      }
      done = next?.done === true;
    }
  } finally {
    if (!done) {
      try {
        await codemode.agent_turn_cancel({
          sessionId: start.sessionId,
          runId: start.runId,
        });
      } catch (error) {}
    }
  }
};
const refreshAccessToken = async (providerName) =>
  __kodyRefreshAccessToken(providerName);
const createAuthenticatedFetch = async (providerName) =>
  __kodyCreateAuthenticatedFetch(providerName);
const agentChatTurnStream = (input) =>
  __kodyAgentChatTurnStream(input);
`.trim()
}
