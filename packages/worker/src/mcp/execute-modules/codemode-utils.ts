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
  return payload.access_token;
};
const __kodyCreateAuthenticatedFetch = async (providerName) => {
  const connector = await __kodyReadConnectorConfig(providerName);
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
const refreshAccessToken = async (providerName) =>
  __kodyRefreshAccessToken(providerName);
const createAuthenticatedFetch = async (providerName) =>
  __kodyCreateAuthenticatedFetch(providerName);
`.trim()
}
