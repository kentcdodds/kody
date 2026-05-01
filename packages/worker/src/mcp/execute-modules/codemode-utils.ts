import {
	assertConnectorHostAllowed,
	ConnectorHostNotAllowedError,
} from './connector-host-allowlist.ts'

export { ConnectorHostNotAllowedError }

type CapabilityResult = unknown

export type CapabilityArgs = Record<string, unknown>

export type CodemodeNamespace = Record<
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

export type ExecuteRequestInput = string | URL | Request

export const EXECUTE_HELPER_CAPABILITY_NAMES = [
	'connector_get',
	'value_get',
	'secret_set',
	'agent_turn_start',
	'agent_turn_next',
	'agent_turn_cancel',
] as const

/**
 * @internal
 * Refreshes and returns the raw OAuth access token for the named connector.
 *
 * **Security boundary**: The returned value is a materialized credential. Once
 * in caller hands, the fetch gateway's host-allowlist check is bypassed because
 * the gateway can only inspect secret *placeholders*. Callers that forward this
 * token in outbound requests MUST enforce the connector's host allowlist
 * themselves (see `assertConnectorHostAllowed`). Prefer
 * `createAuthenticatedFetch` which performs this enforcement automatically.
 */
export async function refreshAccessToken(
	codemode: CodemodeNamespace,
	providerName: string,
): Promise<string> {
	const connector = await readConnectorConfig(codemode, providerName)
	return refreshAccessTokenWithConnector(codemode, providerName, connector)
}

export async function createAuthenticatedFetch(
	codemode: CodemodeNamespace,
	providerName: string,
): Promise<
	(input: ExecuteRequestInput, init?: RequestInit) => Promise<Response>
> {
	const connector = await readConnectorConfig(codemode, providerName)
	const accessToken = await refreshAccessTokenWithConnector(
		codemode,
		providerName,
		connector,
	)

	return async (input: ExecuteRequestInput, init?: RequestInit) => {
		const resolvedUrl = resolveRequestUrl(input, connector)
		assertConnectorHostAllowed(providerName, connector, resolvedUrl)

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

async function readConnectorConfig(
	codemode: CodemodeNamespace,
	providerName: string,
) {
	const connectorGet = codemode.connector_get
	if (typeof connectorGet !== 'function') {
		throw new Error('codemode.connector_get is not available in this sandbox.')
	}
	const result = (await connectorGet({
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
	const valueGet = codemode.value_get
	if (typeof valueGet !== 'function') {
		throw new Error('codemode.value_get is not available in this sandbox.')
	}
	const value = (await valueGet({
		name: connector.clientIdValueName,
	})) as ValueGetResult
	if (!value?.value) {
		throw new Error(
			`Client ID value "${connector.clientIdValueName}" was not found.`,
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
			`Connector "${providerName}" does not define an ${secretKind} secret name.`,
		)
	}
	await secretSet({
		name: normalizedSecretName,
		value,
		scope: 'user',
	})
}

async function refreshAccessTokenWithConnector(
	codemode: CodemodeNamespace,
	providerName: string,
	connector: ConnectorConfig,
) {
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
		const clientSecretSecretName =
			connector.clientSecretSecretName?.trim() ?? ''
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
	const payload = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null

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
		connector.accessTokenSecretName,
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
	connector: ConnectorConfig,
) {
	if (typeof input === 'string' && input.startsWith('/')) {
		return resolveRelativeUrl(input, connector)
	}
	if (input instanceof URL) return input
	if (typeof input === 'string') return input
	if (input instanceof Request) {
		const relativePath = getRelativePathFromRequest(input, connector)
		if (relativePath) {
			return new Request(resolveRelativeUrl(relativePath, connector), input)
		}
	}
	return input
}

function getRelativePathFromRequest(
	input: Request,
	connector: ConnectorConfig,
): string | null {
	const requestUrl = new URL(input.url)
	const normalizedBase = getNormalizedApiBaseUrl(connector)
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

function getNormalizedApiBaseUrl(connector: ConnectorConfig) {
	if (!connector.apiBaseUrl) return null
	return connector.apiBaseUrl.endsWith('/')
		? connector.apiBaseUrl.slice(0, -1)
		: connector.apiBaseUrl
}

function resolveRelativeUrl(pathname: string, connector: ConnectorConfig) {
	const normalizedBase = getNormalizedApiBaseUrl(connector)
	if (!normalizedBase) {
		throw new Error(
			`Connector "${connector.name}" does not define apiBaseUrl for relative requests.`,
		)
	}
	return new URL(`${normalizedBase}${pathname}`)
}

export function getExecuteHelperCapabilityNames() {
	return [...EXECUTE_HELPER_CAPABILITY_NAMES]
}

export function createExecuteHelperPrelude() {
	return `
class ConnectorHostNotAllowedError extends Error {
  constructor(connectorName, disallowedHost) {
    super(
      \`Connector "\${connectorName}" does not allow requests to host "\${disallowedHost}". \` +
        \`The host must be listed in the connector's requiredHosts or match its apiBaseUrl.\`
    );
    this.name = 'ConnectorHostNotAllowedError';
    this.connectorName = connectorName;
    this.disallowedHost = disallowedHost;
  }
}
const __kodyGetConnectorAllowedHosts = (connector) => {
  const hosts = new Set();
  if (connector.requiredHosts) {
    for (const host of connector.requiredHosts) {
      const normalized = host.trim().toLowerCase();
      if (normalized) hosts.add(normalized);
    }
  }
  if (connector.apiBaseUrl) {
    try {
      const apiHost = new URL(connector.apiBaseUrl).hostname.trim().toLowerCase();
      if (apiHost) hosts.add(apiHost);
    } catch {}
  }
  return Array.from(hosts);
};
const __kodyAssertConnectorHostAllowed = (connectorName, connector, url) => {
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
  const allowedHosts = __kodyGetConnectorAllowedHosts(connector);
  if (allowedHosts.length === 0) {
    throw new Error(
      \`Connector "\${connectorName}" has no allowed hosts configured (requiredHosts and apiBaseUrl are both empty). \` +
        \`Cannot attach credentials without a host allowlist.\`
    );
  }
  if (!allowedHosts.includes(requestHost)) {
    throw new ConnectorHostNotAllowedError(connectorName, requestHost);
  }
};
const __kodyBuildSecretPlaceholder = (name, scope) =>
  \`{{secret:\${name}|scope=\${scope}}}\`;
const __kodyReadConnectorConfig = async (providerName) => {
  const connectorGet = codemode.connector_get;
  if (typeof connectorGet !== 'function') {
    throw new Error('codemode.connector_get is not available in this sandbox.');
  }
  const result = await connectorGet({ name: providerName });
  const connector = result?.connector ?? null;
  if (!connector) {
    throw new Error(\`Connector "\${providerName}" was not found.\`);
  }
  return connector;
};
const __kodyReadClientId = async (connector) => {
  const valueGet = codemode.value_get;
  if (typeof valueGet !== 'function') {
    throw new Error('codemode.value_get is not available in this sandbox.');
  }
  const value = await valueGet({ name: connector.clientIdValueName });
  if (!value?.value) {
    throw new Error(
      \`Client ID value "\${connector.clientIdValueName}" was not found.\`,
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
      \`Connector "\${providerName}" does not define an \${secretKind} secret name.\`,
    );
  }
  await secretSet({
    name: normalizedSecretName,
    value,
    scope: 'user',
  });
};
const __kodyGetNormalizedApiBaseUrl = (connector) => {
  if (!connector.apiBaseUrl) return null;
  return connector.apiBaseUrl.endsWith('/')
    ? connector.apiBaseUrl.slice(0, -1)
    : connector.apiBaseUrl;
};
const __kodyGetRuntimeOrigin = () => {
  const origin = globalThis.location?.origin ?? null;
  return typeof origin === 'string' && origin.length > 0 ? origin : null;
};
const __kodyResolveRelativeUrl = (pathname, connector) => {
  const normalizedBase = __kodyGetNormalizedApiBaseUrl(connector);
  if (!normalizedBase) {
    throw new Error(
      \`Connector "\${connector.name}" does not define apiBaseUrl for relative requests.\`,
    );
  }
  return new URL(\`\${normalizedBase}\${pathname}\`);
};
const __kodyGetRelativePathFromRequest = (input, connector) => {
  const requestUrl = new URL(input.url);
  const normalizedBase = __kodyGetNormalizedApiBaseUrl(connector);
  if (normalizedBase && requestUrl.href.startsWith(normalizedBase)) {
    return null;
  }
  const runtimeOrigin = __kodyGetRuntimeOrigin();
  if (!runtimeOrigin || requestUrl.origin !== runtimeOrigin) {
    return null;
  }
  return \`\${requestUrl.pathname}\${requestUrl.search}\${requestUrl.hash}\`;
};
const __kodyResolveRequestUrl = (input, connector) => {
  if (typeof input === 'string' && input.startsWith('/')) {
    return __kodyResolveRelativeUrl(input, connector);
  }
  if (input instanceof URL) return input;
  if (typeof input === 'string') return input;
  if (input instanceof Request) {
    const relativePath = __kodyGetRelativePathFromRequest(input, connector);
    if (relativePath) {
      return new Request(__kodyResolveRelativeUrl(relativePath, connector), input);
    }
  }
  return input;
};
const __kodyRefreshAccessToken = async (providerName) => {
  const connector = await __kodyReadConnectorConfig(providerName);
  const clientId = await __kodyReadClientId(connector);
  const refreshTokenSecretName = connector.refreshTokenSecretName?.trim() ?? '';
  if (!refreshTokenSecretName) {
    throw new Error(
      \`Connector "\${providerName}" does not define a refresh token secret name.\`,
    );
  }
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set(
    'refresh_token',
    __kodyBuildSecretPlaceholder(refreshTokenSecretName, 'user'),
  );
  params.set('client_id', clientId);
  if (connector.flow === 'confidential') {
    const clientSecretSecretName = connector.clientSecretSecretName?.trim() ?? '';
    if (!clientSecretSecretName) {
      throw new Error(
        \`Connector "\${providerName}" uses confidential flow but does not define a client secret secret name.\`,
      );
    }
    params.set(
      'client_secret',
      __kodyBuildSecretPlaceholder(clientSecretSecretName, 'user'),
    );
  }
  const response = await fetch(connector.tokenUrl, {
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
      \`Token refresh failed for connector "\${providerName}" with HTTP \${response.status}.\`,
    );
  }
  if (!payload || typeof payload.access_token !== 'string') {
    throw new Error(
      \`Token refresh for connector "\${providerName}" did not return an access_token.\`,
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
    connector.accessTokenSecretName,
    'access token',
    payload.access_token,
  );
  return payload.access_token;
};
const __kodyCreateAuthenticatedFetch = async (providerName) => {
  const connector = await __kodyReadConnectorConfig(providerName);
  const accessToken = await __kodyRefreshAccessToken(providerName);
  return async (input, init) => {
    const resolvedUrl = __kodyResolveRequestUrl(input, connector);
    __kodyAssertConnectorHostAllowed(providerName, connector, resolvedUrl);
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
