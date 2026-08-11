import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import { resolveSecret, saveSecret } from '#mcp/secrets/service.ts'
import {
	buildOAuthTokenExchangeRequest,
	resolveTokenExchangeStyle,
} from './oauth-token-exchange.ts'
import { getPlatformOauthAppClientSecret } from './platform-apps.ts'
import { getJoinedIntegration } from './service.ts'

export type IntegrationTokenRefreshResult = {
	refreshedAt: string
	refreshTokenRotated: boolean
}

/**
 * Caller-clearable token-refresh failures: missing refresh token on the
 * connection, revoked/expired provider grant (HTTP 4xx), host-approval gaps,
 * and similar reconnectable state. MCP capabilities re-wrap this as
 * `McpCallerError` so agents get a clear next step and Sentry stays quiet.
 */
export class IntegrationTokenRefreshCallerError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'IntegrationTokenRefreshCallerError'
	}
}

/**
 * Trailing marker on every `IntegrationTokenRefreshCallerError` message. MCP
 * observability and Sentry `beforeSend` match this so reconnectable OAuth
 * state stays on structured `mcp-event` logs and out of Sentry — without
 * over-matching unrelated "Integration …" strings elsewhere.
 */
export const integrationTokenRefreshCallerMarker =
	'(integration_token_refresh caller state)'

export function isIntegrationTokenRefreshCallerMessage(message: string) {
	return message.includes(integrationTokenRefreshCallerMarker)
}

function callerRefreshError(message: string, options?: ErrorOptions) {
	return new IntegrationTokenRefreshCallerError(
		`${message} ${integrationTokenRefreshCallerMarker}`,
		options,
	)
}

function connectOauthPath(integrationName: string) {
	return `/connect/oauth?provider=${encodeURIComponent(integrationName)}`
}

function formatProviderTokenError(payload: Record<string, unknown> | null) {
	if (!payload) return null
	const error =
		typeof payload.error === 'string' ? payload.error.trim().slice(0, 80) : ''
	const description =
		typeof payload.error_description === 'string'
			? payload.error_description.trim().slice(0, 200)
			: ''
	if (!error && !description) return null
	if (error && description) return `${error}: ${description}`
	return error || description
}

/**
 * Host-side OAuth token refresh. Runs entirely in the Worker: the refresh
 * token and client secret are materialized here (never in the sandbox), the
 * provider response is parsed here, and only fresh token *values* are written
 * back to the user's secret store. Callers receive metadata, never tokens.
 *
 * This is the only refresh path for platform-app connections, whose shared
 * client secret has no user-facing secret name by design. User-lane
 * connections may also refresh here (`integration_token_refresh`).
 */
export async function refreshIntegrationTokens(input: {
	env: Env
	userId: string
	userEmail?: string | undefined
	name: string
}): Promise<IntegrationTokenRefreshResult> {
	const joined = await getJoinedIntegration({
		env: input.env,
		userId: input.userId,
		name: input.name,
	})
	if (!joined) {
		throw callerRefreshError(`Integration "${input.name}" was not found.`)
	}
	const { app, connection } = joined
	const reconnectPath = connectOauthPath(connection.name)
	const clientId = app.clientId.trim()
	if (!clientId) {
		throw callerRefreshError(
			`Integration "${connection.name}" does not define a client id. Reconnect at ${reconnectPath}.`,
		)
	}
	const refreshTokenSecretName = connection.refreshTokenSecretName?.trim() ?? ''
	if (!refreshTokenSecretName) {
		throw callerRefreshError(
			`Integration "${connection.name}" does not define a refresh token secret name. This connection cannot refresh; reconnect at ${reconnectPath} if the provider issues a refresh token, or stop calling integration_token_refresh for this integration.`,
		)
	}
	const accessTokenSecretName = connection.accessTokenSecretName.trim()
	if (!accessTokenSecretName) {
		throw callerRefreshError(
			`Integration "${connection.name}" does not define an access token secret name. Reconnect at ${reconnectPath}.`,
		)
	}

	const storageContext = { sessionId: null, appId: null, packageId: null }
	// User-lane destinations are user-configurable (integration_save can point
	// tokenUrl anywhere), so materializing user secrets here must honor the
	// same per-secret host allowlist the fetch gateway enforces for
	// placeholder resolution. Platform-lane destinations are operator-pinned
	// rows, so no user-secret allowlist applies.
	const tokenHost = safeParseHost(app.tokenUrl)
	if (!tokenHost) {
		throw callerRefreshError(
			`Integration "${connection.name}" has an invalid token URL.`,
		)
	}
	const assertUserSecretAllowedForTokenHost = (
		secretName: string,
		allowedHosts: Array<string>,
	) => {
		if (joined.lane !== 'user') return
		if (allowedHosts.includes(tokenHost)) return
		throw callerRefreshError(
			`Secret "${secretName}" is not approved for host "${tokenHost}". Approve the host on /account/secrets before refreshing this integration.`,
		)
	}

	const refreshTokenSecret = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: refreshTokenSecretName,
		scope: 'user',
		storageContext,
	})
	if (!refreshTokenSecret.found || !refreshTokenSecret.value) {
		throw callerRefreshError(
			`Refresh token secret "${refreshTokenSecretName}" was not found. Reconnect at ${reconnectPath}.`,
		)
	}
	assertUserSecretAllowedForTokenHost(
		refreshTokenSecretName,
		refreshTokenSecret.allowedHosts,
	)

	let clientSecret: string | null = null
	if (app.flow === 'confidential') {
		switch (joined.lane) {
			case 'platform': {
				clientSecret = await getPlatformOauthAppClientSecret({
					db: input.env.APP_DB,
					env: input.env,
					slug: joined.app.slug,
				})
				break
			}
			case 'user': {
				const clientSecretSecretName =
					joined.app.clientSecretSecretName?.trim() ?? ''
				if (!clientSecretSecretName) {
					throw callerRefreshError(
						`Integration "${connection.name}" uses confidential flow but does not define a client secret secret name.`,
					)
				}
				const resolved = await resolveSecret({
					env: input.env,
					userId: input.userId,
					name: clientSecretSecretName,
					scope: 'user',
					storageContext,
				})
				if (resolved.found) {
					assertUserSecretAllowedForTokenHost(
						clientSecretSecretName,
						resolved.allowedHosts,
					)
				}
				clientSecret = resolved.found ? (resolved.value ?? null) : null
				break
			}
			default: {
				const exhaustiveCheck: never = joined
				throw new Error(
					`Unhandled integration lane: ${String(exhaustiveCheck)}`,
				)
			}
		}
		if (!clientSecret) {
			throw callerRefreshError(
				`Client secret for integration "${connection.name}" was not found.`,
			)
		}
	}

	const params = new URLSearchParams()
	params.set('grant_type', 'refresh_token')
	params.set('refresh_token', refreshTokenSecret.value)
	params.set('client_id', clientId)
	const style = resolveTokenExchangeStyle({
		tokenUrl: app.tokenUrl,
		tokenExchangeStyle: app.tokenExchangeStyle,
	})
	const exchangeRequest = buildOAuthTokenExchangeRequest({
		params,
		flow: app.flow,
		clientSecret,
		style,
	})

	// Bound the provider round trip: every integration_token_refresh caller
	// (including createAuthenticatedFetch's automatic 401 retry) inherits this
	// latency, so a stalled token endpoint must not hold the invocation open.
	const response = await fetch(app.tokenUrl, {
		method: 'POST',
		headers: exchangeRequest.headers,
		body: exchangeRequest.body,
		signal: AbortSignal.timeout(30_000),
	})
	const payload = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	if (!response.ok) {
		const providerDetail = formatProviderTokenError(payload)
		const detailSuffix = providerDetail ? ` (${providerDetail})` : ''
		// Provider 4xx is almost always revoked/expired grant or bad client
		// state the user (or operator) clears by reconnecting — not a platform
		// defect worth a Sentry issue. 5xx stays a plain Error for visibility.
		if (response.status >= 400 && response.status < 500) {
			throw callerRefreshError(
				`Token refresh was rejected for integration "${connection.name}" with HTTP ${response.status}${detailSuffix}. Reconnect at ${reconnectPath}.`,
			)
		}
		throw new Error(
			`Token refresh failed for integration "${connection.name}" with HTTP ${response.status}${detailSuffix}.`,
		)
	}
	if (!payload || typeof payload.access_token !== 'string') {
		throw callerRefreshError(
			`Token refresh for integration "${connection.name}" did not return an access_token. Reconnect at ${reconnectPath}.`,
		)
	}

	// Refresh-token-before-access-token stays load-bearing for rotating
	// providers: if the process dies mid-write, keeping the new refresh token
	// is preferable to keeping only the new access token.
	const refreshTokenRotated =
		typeof payload.refresh_token === 'string' &&
		payload.refresh_token.length > 0
	if (refreshTokenRotated) {
		await saveSecret({
			env: input.env,
			userId: input.userId,
			userEmail: input.userEmail,
			name: refreshTokenSecretName,
			value: payload.refresh_token as string,
			scope: 'user',
			description: `${connection.name} OAuth refresh token`,
			storageContext,
		})
	}
	await saveSecret({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		name: accessTokenSecretName,
		value: payload.access_token,
		scope: 'user',
		description: `${connection.name} OAuth access token`,
		storageContext,
	})

	const refreshedAt = new Date().toISOString()
	await input.env.APP_DB.prepare(
		`UPDATE user_integrations
		SET token_refreshed_at = ?, updated_at = ?
		WHERE user_id = ? AND name = ?`,
	)
		.bind(refreshedAt, refreshedAt, input.userId, connection.name)
		.run()

	return { refreshedAt, refreshTokenRotated }
}
