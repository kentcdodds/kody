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
	readiness?: {
		status: 'ready' | 'missing_prerequisites'
		authenticatedRequestsReady: boolean
		available: {
			clientIdValue: boolean
			accessTokenSecret: boolean
			refreshTokenSecret: boolean | null
			clientSecretSecret: boolean | null
		}
		missingPrerequisites: Array<{
			kind: 'value' | 'secret' | 'config'
			requirement: 'client_id' | 'refresh_token' | 'client_secret'
			name: string | null
		}>
	} | null
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

export async function refreshAccessToken(
	codemode: CodemodeNamespace,
	providerName: string,
): Promise<string> {
	const connectorResult = await readConnectorConfig(codemode, providerName)
	return refreshAccessTokenWithConnector(
		codemode,
		providerName,
		connectorResult.connector,
		connectorResult.readiness,
	)
}

export async function createAuthenticatedFetch(
	codemode: CodemodeNamespace,
	providerName: string,
): Promise<
	(input: ExecuteRequestInput, init?: RequestInit) => Promise<Response>
> {
	const connectorResult = await readConnectorConfig(codemode, providerName)
	const accessToken = await refreshAccessTokenWithConnector(
		codemode,
		providerName,
		connectorResult.connector,
		connectorResult.readiness,
	)

	return async (input: ExecuteRequestInput, init?: RequestInit) => {
		const request = new Request(
			resolveRequestUrl(input, connectorResult.connector),
			init,
		)
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
	return {
		connector,
		readiness: result?.readiness ?? null,
	}
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
	readiness: ConnectorGetResult['readiness'],
) {
	assertConnectorReadyForAuthenticatedRequests(providerName, readiness)
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
			buildTokenRefreshFailureMessage(providerName, response.status, readiness),
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

function assertConnectorReadyForAuthenticatedRequests(
	providerName: string,
	readiness: ConnectorGetResult['readiness'],
) {
	if (!readiness || readiness.authenticatedRequestsReady) {
		return
	}
	const missingSummary = readiness.missingPrerequisites
		.map(formatMissingPrerequisite)
		.join('; ')
	throw new Error(
		`Connector "${providerName}" is not ready for authenticated requests: ${missingSummary}.`,
	)
}

function formatMissingPrerequisite(
	prerequisite: NonNullable<ConnectorGetResult['readiness']>['missingPrerequisites'][number],
) {
	if (prerequisite.requirement === 'client_id') {
		return `client ID value "${prerequisite.name ?? 'unknown'}" is missing`
	}
	if (prerequisite.requirement === 'refresh_token') {
		if (prerequisite.kind === 'config') {
			return 'connector config does not define a refresh token secret name'
		}
		return `refresh token secret "${prerequisite.name ?? 'unknown'}" is missing`
	}
	if (prerequisite.kind === 'config') {
		return 'connector config does not define a client secret secret name'
	}
	return `client secret "${prerequisite.name ?? 'unknown'}" is missing`
}

function buildTokenRefreshFailureMessage(
	providerName: string,
	status: number,
	readiness: ConnectorGetResult['readiness'],
) {
	const details =
		readiness && readiness.missingPrerequisites.length > 0
			? ` Readiness check also found missing prerequisites: ${readiness.missingPrerequisites
					.map(formatMissingPrerequisite)
					.join('; ')}.`
			: ''
	return `Token refresh failed for connector "${providerName}" with HTTP ${status}.${details}`
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
  return {
    connector,
    readiness: result?.readiness ?? null,
  };
};
const __kodyFormatMissingPrerequisite = (prerequisite) => {
  if (prerequisite.requirement === 'client_id') {
    return \`client ID value "\${prerequisite.name ?? 'unknown'}" is missing\`;
  }
  if (prerequisite.requirement === 'refresh_token') {
    if (prerequisite.kind === 'config') {
      return 'connector config does not define a refresh token secret name';
    }
    return \`refresh token secret "\${prerequisite.name ?? 'unknown'}" is missing\`;
  }
  if (prerequisite.kind === 'config') {
    return 'connector config does not define a client secret secret name';
  }
  return \`client secret "\${prerequisite.name ?? 'unknown'}" is missing\`;
};
const __kodyAssertConnectorReadyForAuthenticatedRequests = (
  providerName,
  readiness,
) => {
  if (!readiness || readiness.authenticatedRequestsReady) {
    return;
  }
  const missingSummary = readiness.missingPrerequisites
    .map(__kodyFormatMissingPrerequisite)
    .join('; ');
  throw new Error(
    \`Connector "\${providerName}" is not ready for authenticated requests: \${missingSummary}.\`,
  );
};
const __kodyBuildTokenRefreshFailureMessage = (
  providerName,
  status,
  readiness,
) => {
  const details =
    readiness && readiness.missingPrerequisites.length > 0
      ? \` Readiness check also found missing prerequisites: \${readiness.missingPrerequisites
          .map(__kodyFormatMissingPrerequisite)
          .join('; ')}.\`
      : '';
  return \`Token refresh failed for connector "\${providerName}" with HTTP \${status}.\${details}\`;
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
  const connectorResult = await __kodyReadConnectorConfig(providerName);
  __kodyAssertConnectorReadyForAuthenticatedRequests(
    providerName,
    connectorResult.readiness,
  );
  const connector = connectorResult.connector;
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
      __kodyBuildTokenRefreshFailureMessage(
        providerName,
        response.status,
        connectorResult.readiness,
      ),
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
  const connectorResult = await __kodyReadConnectorConfig(providerName);
  const connector = connectorResult.connector;
  const accessToken = await __kodyRefreshAccessToken(providerName);
  return async (input, init) => {
    const request = new Request(__kodyResolveRequestUrl(input, connector), init);
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
