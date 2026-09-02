import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import {
	integrationAuthFailureCopy,
	type IntegrationAuthFailureReason,
} from '#universal/connection-trouble.ts'
import {
	persistIntegrationTokens,
	resolveIntegrationRefreshToken,
	resolveUserOauthAppClientSecret,
} from './credentials.ts'
import { writeIntegrationAuthFailure } from './repo.ts'
import { assertCanUseIntegration } from './package-access.ts'
import {
	buildOAuthTokenExchangeRequest,
	resolveTokenExchangeStyle,
} from './oauth-token-exchange.ts'
import { isAccountEmailLabel } from './account-identity.ts'
import { getPlatformOauthAppClientSecret } from './platform-apps.ts'
import { getJoinedIntegration } from './service.ts'
import { type JoinedIntegration } from './types.ts'

export type IntegrationTokenRefreshResult = {
	refreshedAt: string
	refreshTokenRotated: boolean
}

export const integrationAuthFailedReasons = [
	'missing_refresh_token',
	'provider_rejected',
	'missing_secret',
	'host_not_approved',
	'invalid_config',
] as const

export type IntegrationAuthFailedReason =
	(typeof integrationAuthFailedReasons)[number]

export type IntegrationTokenRefreshCallerReason =
	| IntegrationAuthFailedReason
	| 'not_found'

export type IntegrationAuthFailedSnapshot = {
	name: string
	lane: 'user' | 'platform'
	accountLabel: string | null
	description: string | null
	provider: string | null
	platformAppSlug: string | null
	scopes: Array<string>
	connectedAt: string | null
	tokenRefreshedAt: string | null
}

/**
 * Caller-clearable token-refresh failures: missing refresh token on the
 * connection, revoked/expired provider grant (HTTP 4xx), host-approval gaps,
 * and similar reconnectable state. MCP capabilities re-wrap this as
 * `McpCallerError` so agents get a clear next step and Sentry stays quiet.
 */
export class IntegrationTokenRefreshCallerError extends Error {
	readonly reason: IntegrationTokenRefreshCallerReason
	readonly providerError: string | null
	readonly providerErrorDescription: string | null
	readonly httpStatus: number | null
	readonly integration: IntegrationAuthFailedSnapshot | null

	constructor(
		message: string,
		options: ErrorOptions & {
			reason: IntegrationTokenRefreshCallerReason
			providerError?: string | null
			providerErrorDescription?: string | null
			httpStatus?: number | null
			integration?: IntegrationAuthFailedSnapshot | null
		},
	) {
		const {
			reason,
			providerError,
			providerErrorDescription,
			httpStatus,
			integration,
			...errorOptions
		} = options
		super(message, errorOptions)
		this.name = 'IntegrationTokenRefreshCallerError'
		this.reason = reason
		this.providerError = providerError ?? null
		this.providerErrorDescription = providerErrorDescription ?? null
		this.httpStatus = httpStatus ?? null
		this.integration = integration ?? null
	}
}

/**
 * Trailing marker on every `IntegrationTokenRefreshCallerError` message. MCP
 * observability and Sentry `beforeSend` match this so reconnectable OAuth
 * state stays on structured `mcp-event` logs and out of Sentry — without
 * over-matching unrelated "Integration …" strings elsewhere.
 */
export const integrationTokenRefreshCallerMarker =
	'(integrationTokenRefresh caller state)'

export function isIntegrationTokenRefreshCallerMessage(message: string) {
	return message.includes(integrationTokenRefreshCallerMarker)
}

function callerRefreshError(
	message: string,
	options: ErrorOptions & {
		reason: IntegrationTokenRefreshCallerReason
		providerError?: string | null
		providerErrorDescription?: string | null
		httpStatus?: number | null
		integration?: IntegrationAuthFailedSnapshot | null
	},
) {
	return new IntegrationTokenRefreshCallerError(
		`${message} ${integrationTokenRefreshCallerMarker}`,
		options,
	)
}

function connectOauthPath(integrationName: string) {
	return `/connect/oauth?provider=${encodeURIComponent(integrationName)}`
}

function snapshotJoinedIntegration(
	joined: JoinedIntegration,
): IntegrationAuthFailedSnapshot {
	return {
		name: joined.connection.name,
		lane: joined.lane,
		accountLabel: joined.connection.accountLabel,
		description: joined.connection.description.trim() || null,
		provider: joined.app.provider,
		platformAppSlug: joined.connection.platformAppSlug,
		scopes: joined.connection.scopes,
		connectedAt: joined.connection.connectedAt,
		tokenRefreshedAt: joined.connection.tokenRefreshedAt,
	}
}

async function maybePersistGoogleAccountLabel(input: {
	env: Env
	userId: string
	name: string
	accountLabel: string | null
	requiredHosts: Array<string>
	accessToken: string
}) {
	if (input.accountLabel?.trim()) return
	if (!input.requiredHosts.includes('openidconnect.googleapis.com')) return
	try {
		const response = await fetch(
			'https://openidconnect.googleapis.com/v1/userinfo',
			{
				headers: { Authorization: `Bearer ${input.accessToken}` },
				signal: AbortSignal.timeout(5_000),
			},
		)
		if (!response.ok) return
		const payload = (await response.json().catch(() => null)) as {
			email?: unknown
		} | null
		const email = typeof payload?.email === 'string' ? payload.email.trim() : ''
		if (!isAccountEmailLabel(email)) return
		const now = new Date().toISOString()
		await input.env.APP_DB.prepare(
			`UPDATE user_integrations
			SET account_label = ?, updated_at = ?
			WHERE user_id = ? AND name = ?
				AND (account_label IS NULL OR account_label = '')`,
		)
			.bind(email, now, input.userId, input.name)
			.run()
	} catch {
		// Identity capture is best-effort and must never fail a successful refresh.
	}
}

function readProviderTokenError(payload: Record<string, unknown> | null) {
	if (!payload) {
		return { error: null, description: null }
	}
	const error =
		typeof payload.error === 'string' ? payload.error.trim().slice(0, 80) : ''
	const description =
		typeof payload.error_description === 'string'
			? payload.error_description.trim().slice(0, 200)
			: ''
	return {
		error: error || null,
		description: description || null,
	}
}

function formatProviderTokenError(payload: Record<string, unknown> | null) {
	const { error, description } = readProviderTokenError(payload)
	if (!error && !description) return null
	if (error && description) return `${error}: ${description}`
	return error || description
}

async function emitIntegrationAuthFailedEvent(input: {
	env: Env
	userId: string
	error: IntegrationTokenRefreshCallerError
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const snapshot = input.error.integration
	if (!snapshot) return
	if (input.error.reason === 'not_found') return
	try {
		const { dispatchIntegrationAuthFailedSubscriptionEvents } =
			await import('./package-subscriptions.ts')
		await dispatchIntegrationAuthFailedSubscriptionEvents({
			env: input.env,
			userId: input.userId,
			eventId: crypto.randomUUID(),
			occurredAt: new Date().toISOString(),
			integration: {
				name: snapshot.name,
				lane: snapshot.lane,
				account_label: snapshot.accountLabel,
				description: snapshot.description,
				provider: snapshot.provider,
				platform_app_slug: snapshot.platformAppSlug,
				scopes: snapshot.scopes,
				connected_at: snapshot.connectedAt,
				token_refreshed_at: snapshot.tokenRefreshedAt,
			},
			reason: input.error.reason,
			provider: {
				error: input.error.providerError,
				error_description: input.error.providerErrorDescription,
				http_status: input.error.httpStatus,
			},
			waitUntil: input.waitUntil,
		})
	} catch (error) {
		console.warn(
			'integration.auth.failed package subscription dispatch failed',
			{
				integrationName: snapshot.name,
				error,
			},
		)
	}
}

async function emitIntegrationAuthSucceededEvent(input: {
	env: Env
	userId: string
	integration: IntegrationAuthFailedSnapshot
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	try {
		const { dispatchIntegrationAuthSucceededSubscriptionEvents } =
			await import('./package-subscriptions.ts')
		await dispatchIntegrationAuthSucceededSubscriptionEvents({
			env: input.env,
			userId: input.userId,
			eventId: crypto.randomUUID(),
			occurredAt: new Date().toISOString(),
			integration: {
				name: input.integration.name,
				lane: input.integration.lane,
				account_label: input.integration.accountLabel,
				description: input.integration.description,
				provider: input.integration.provider,
				platform_app_slug: input.integration.platformAppSlug,
				scopes: input.integration.scopes,
				connected_at: input.integration.connectedAt,
				token_refreshed_at: input.integration.tokenRefreshedAt,
			},
			source: 'refresh',
			waitUntil: input.waitUntil,
		})
	} catch (error) {
		console.warn(
			'integration.auth.succeeded package subscription dispatch failed',
			{
				integrationName: input.integration.name,
				error,
			},
		)
	}
}

function scheduleSubscriptionEmit(
	waitUntil: ((promise: Promise<unknown>) => void) | undefined,
	pending: Promise<unknown>,
) {
	if (waitUntil) {
		waitUntil(pending)
		return
	}
	return pending
}

/**
 * Host-side OAuth token refresh. Runs entirely in the Worker: the refresh
 * token and client secret are materialized here (never in the sandbox), the
 * provider response is parsed here, and only fresh token *values* are written
 * back to the user's secret store. Callers receive metadata, never tokens.
 *
 * This is the only refresh path for platform-app connections, whose shared
 * client secret has no user-facing secret name by design. User-lane
 * connections may also refresh here (`integrationTokenRefresh`).
 *
 * Reconnectable caller-errors emit `integration.auth.failed` once per attempt
 * and persist a last-failure snapshot for Waiting / Integrations. Provider
 * HTTP 5xx and timeouts persist `provider_unavailable` without emitting
 * failed or inventing a Waiting row. Successful refreshes clear the snapshot
 * and emit `integration.auth.succeeded`. Sequential attempts each emit;
 * notifier packages edge-detect working ↔ failed. Concurrent in-flight
 * refreshes of the same connection share one provider POST, persist, and
 * event so a 401 stampede cannot rotate the refresh token out from under
 * itself.
 */
const inFlightIntegrationTokenRefreshes = new Map<
	string,
	Promise<IntegrationTokenRefreshResult>
>()

function integrationTokenRefreshDedupeKey(userId: string, name: string) {
	return `${userId}\0${name}`
}

export async function refreshIntegrationTokens(input: {
	env: Env
	userId: string
	userEmail?: string | undefined
	name: string
	baseUrl?: string
	packageId?: string | null
	packageKodyId?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<IntegrationTokenRefreshResult> {
	const key = integrationTokenRefreshDedupeKey(input.userId, input.name)
	const existing = inFlightIntegrationTokenRefreshes.get(key)
	if (existing) return existing
	let resolvePending!: (value: IntegrationTokenRefreshResult) => void
	let rejectPending!: (reason: unknown) => void
	const pending = new Promise<IntegrationTokenRefreshResult>(
		(resolve, reject) => {
			resolvePending = resolve
			rejectPending = reject
		},
	)
	inFlightIntegrationTokenRefreshes.set(key, pending)
	void refreshIntegrationTokensAttempt(input)
		.then(resolvePending, rejectPending)
		.finally(() => {
			if (inFlightIntegrationTokenRefreshes.get(key) === pending) {
				inFlightIntegrationTokenRefreshes.delete(key)
			}
		})
	return pending
}

async function refreshIntegrationTokensAttempt(input: {
	env: Env
	userId: string
	userEmail?: string | undefined
	name: string
	baseUrl?: string
	packageId?: string | null
	packageKodyId?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<IntegrationTokenRefreshResult> {
	try {
		return await refreshIntegrationTokensOrThrow(input)
	} catch (error) {
		if (error instanceof IntegrationTokenRefreshCallerError) {
			await persistAuthFailureSnapshot({
				env: input.env,
				userId: input.userId,
				error,
			})
			const pending = emitIntegrationAuthFailedEvent({
				env: input.env,
				userId: input.userId,
				error,
				waitUntil: input.waitUntil,
			})
			await scheduleSubscriptionEmit(input.waitUntil, pending)
		}
		throw error
	}
}

async function refreshIntegrationTokensOrThrow(input: {
	env: Env
	userId: string
	userEmail?: string | undefined
	name: string
	baseUrl?: string
	packageId?: string | null
	packageKodyId?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<IntegrationTokenRefreshResult> {
	if (input.baseUrl) {
		await assertCanUseIntegration({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			name: input.name,
			packageId: input.packageId,
			packageKodyId: input.packageKodyId,
		})
	}
	const joined = await getJoinedIntegration({
		env: input.env,
		userId: input.userId,
		name: input.name,
	})
	if (!joined) {
		throw callerRefreshError(`Integration "${input.name}" was not found.`, {
			reason: 'not_found',
		})
	}
	const { app, connection } = joined
	const integration = snapshotJoinedIntegration(joined)
	const reconnectPath = connectOauthPath(connection.name)
	const fail = (
		message: string,
		options: {
			reason: IntegrationAuthFailedReason
			providerError?: string | null
			providerErrorDescription?: string | null
			httpStatus?: number | null
		},
	) =>
		callerRefreshError(message, {
			...options,
			integration,
		})
	const clientId = app.clientId.trim()
	if (!clientId) {
		throw fail(
			`Integration "${connection.name}" does not define a client id. Reconnect at ${reconnectPath}.`,
			{ reason: 'invalid_config' },
		)
	}
	const refreshTokenSecretName = connection.refreshTokenSecretName?.trim() ?? ''
	if (!refreshTokenSecretName) {
		throw fail(
			`Integration "${connection.name}" does not define a refresh token secret name. This connection cannot refresh; reconnect at ${reconnectPath} if the provider issues a refresh token, or stop calling integrationTokenRefresh for this integration.`,
			{ reason: 'missing_refresh_token' },
		)
	}
	const accessTokenSecretName = connection.accessTokenSecretName.trim()
	if (!accessTokenSecretName) {
		throw fail(
			`Integration "${connection.name}" does not define an access token secret name. Reconnect at ${reconnectPath}.`,
			{ reason: 'missing_secret' },
		)
	}

	// User-lane destinations are user-configurable (integrationSave can point
	// tokenUrl anywhere), so materializing user secrets here must honor the
	// same per-secret host allowlist the fetch gateway enforces for
	// placeholder resolution. Platform-lane destinations are operator-pinned
	// rows, so no user-secret allowlist applies.
	const tokenHost = safeParseHost(app.tokenUrl)
	if (!tokenHost) {
		throw fail(`Integration "${connection.name}" has an invalid token URL.`, {
			reason: 'invalid_config',
		})
	}
	const assertUserSecretAllowedForTokenHost = (
		secretName: string,
		allowedHosts: Array<string>,
	) => {
		if (joined.lane !== 'user') return
		if (allowedHosts.includes(tokenHost)) return
		throw fail(
			`Secret "${secretName}" is not approved for host "${tokenHost}". Approve the host on /account/secrets before refreshing this integration.`,
			{ reason: 'host_not_approved' },
		)
	}

	const refreshTokenSecret = await resolveIntegrationRefreshToken({
		env: input.env,
		userId: input.userId,
		name: connection.name,
		secretName: refreshTokenSecretName,
	})
	if (!refreshTokenSecret.value) {
		throw fail(
			`Refresh token secret "${refreshTokenSecretName}" was not found. Reconnect at ${reconnectPath}.`,
			{ reason: 'missing_refresh_token' },
		)
	}
	if (refreshTokenSecret.source === 'secret') {
		assertUserSecretAllowedForTokenHost(
			refreshTokenSecretName,
			refreshTokenSecret.allowedHosts,
		)
	} else if (
		joined.lane === 'user' &&
		!connection.requiredHosts.includes(tokenHost)
	) {
		throw fail(
			`Integration "${connection.name}" is not approved for host "${tokenHost}".`,
			{ reason: 'host_not_approved' },
		)
	}

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
					throw fail(
						`Integration "${connection.name}" uses confidential flow but does not define a client secret secret name.`,
						{ reason: 'missing_secret' },
					)
				}
				const resolved = await resolveUserOauthAppClientSecret({
					env: input.env,
					userId: input.userId,
					slug: joined.app.slug,
					secretName: clientSecretSecretName,
				})
				if (resolved.source === 'secret') {
					assertUserSecretAllowedForTokenHost(
						clientSecretSecretName,
						resolved.allowedHosts,
					)
				} else if (
					joined.lane === 'user' &&
					!connection.requiredHosts.includes(tokenHost)
				) {
					throw fail(
						`Integration "${connection.name}" is not approved for host "${tokenHost}".`,
						{ reason: 'host_not_approved' },
					)
				}
				clientSecret = resolved.value
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
			throw fail(
				`Client secret for integration "${connection.name}" was not found.`,
				{ reason: 'missing_secret' },
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

	// Bound the provider round trip: every integrationTokenRefresh caller
	// (including createAuthenticatedFetch's automatic 401 retry) inherits this
	// latency, so a stalled token endpoint must not hold the invocation open.
	let response: Response
	try {
		response = await fetch(app.tokenUrl, {
			method: 'POST',
			headers: exchangeRequest.headers,
			body: exchangeRequest.body,
			signal: AbortSignal.timeout(30_000),
		})
	} catch (error) {
		if (isProviderTimeoutError(error)) {
			await persistProviderUnavailableSnapshot({
				env: input.env,
				userId: input.userId,
				joined,
			})
			throw new Error(
				`Token refresh timed out for integration "${connection.name}".`,
				{ cause: error },
			)
		}
		throw error
	}
	const payload = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	if (!response.ok) {
		const provider = readProviderTokenError(payload)
		const providerDetail = formatProviderTokenError(payload)
		const detailSuffix = providerDetail ? ` (${providerDetail})` : ''
		// Provider 4xx is almost always revoked/expired grant or bad client
		// state the user (or operator) clears by reconnecting — not a platform
		// defect worth a Sentry issue. 5xx / timeout persist
		// `provider_unavailable` for Integrations without emitting failed.
		if (response.status >= 400 && response.status < 500) {
			throw fail(
				`Token refresh was rejected for integration "${connection.name}" with HTTP ${response.status}${detailSuffix}. Reconnect at ${reconnectPath}.`,
				{
					reason: 'provider_rejected',
					providerError: provider.error,
					providerErrorDescription: provider.description,
					httpStatus: response.status,
				},
			)
		}
		await persistProviderUnavailableSnapshot({
			env: input.env,
			userId: input.userId,
			joined,
			providerError: provider.error,
			providerErrorDescription: provider.description,
			httpStatus: response.status,
		})
		throw new Error(
			`Token refresh failed for integration "${connection.name}" with HTTP ${response.status}${detailSuffix}.`,
		)
	}
	if (
		!payload ||
		typeof payload.access_token !== 'string' ||
		payload.access_token.length === 0
	) {
		throw fail(
			`Token refresh for integration "${connection.name}" did not return an access_token. Reconnect at ${reconnectPath}.`,
			{ reason: 'provider_rejected' },
		)
	}

	// Refresh-token-before-access-token stays load-bearing for rotating
	// providers: if the process dies mid-write, keeping the new refresh token
	// is preferable to keeping only the new access token.
	const refreshTokenRotated =
		typeof payload.refresh_token === 'string' &&
		payload.refresh_token.length > 0
	await persistIntegrationTokens({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		name: connection.name,
		accessToken: payload.access_token,
		refreshToken: refreshTokenRotated
			? (payload.refresh_token as string)
			: null,
		accessTokenSecretName,
		refreshTokenSecretName,
		descriptionPrefix: connection.name,
	})

	const refreshedAt = new Date().toISOString()
	await input.env.APP_DB.prepare(
		`UPDATE user_integrations
		SET token_refreshed_at = ?,
			updated_at = ?,
			auth_failed_at = NULL,
			auth_failed_reason = NULL,
			auth_failed_provider_error = NULL,
			auth_failed_provider_description = NULL,
			auth_failed_http_status = NULL,
			auth_failed_reconnectable = NULL
		WHERE user_id = ? AND name = ?`,
	)
		.bind(refreshedAt, refreshedAt, input.userId, connection.name)
		.run()

	await maybePersistGoogleAccountLabel({
		env: input.env,
		userId: input.userId,
		name: connection.name,
		accountLabel: connection.accountLabel,
		requiredHosts: connection.requiredHosts,
		accessToken: payload.access_token,
	})

	const pending = emitIntegrationAuthSucceededEvent({
		env: input.env,
		userId: input.userId,
		integration,
		waitUntil: input.waitUntil,
	})
	await scheduleSubscriptionEmit(input.waitUntil, pending)

	return { refreshedAt, refreshTokenRotated }
}

async function persistAuthFailureSnapshot(input: {
	env: Env
	userId: string
	error: IntegrationTokenRefreshCallerError
}) {
	const reason = input.error.reason
	if (reason === 'not_found') return
	const snapshot = input.error.integration
	if (!snapshot) return
	await persistAuthFailureRow({
		env: input.env,
		userId: input.userId,
		name: snapshot.name,
		lane: snapshot.lane,
		accountLabel: snapshot.accountLabel,
		reason,
		providerError: input.error.providerError,
		providerErrorDescription: input.error.providerErrorDescription,
		httpStatus: input.error.httpStatus,
		expectedTokenRefreshedAt: snapshot.tokenRefreshedAt,
	})
}

async function persistProviderUnavailableSnapshot(input: {
	env: Env
	userId: string
	joined: JoinedIntegration
	providerError?: string | null
	providerErrorDescription?: string | null
	httpStatus?: number | null
}) {
	await persistAuthFailureRow({
		env: input.env,
		userId: input.userId,
		name: input.joined.connection.name,
		lane: input.joined.lane,
		accountLabel: input.joined.connection.accountLabel,
		reason: 'provider_unavailable',
		providerError: input.providerError ?? null,
		providerErrorDescription: input.providerErrorDescription ?? null,
		httpStatus: input.httpStatus ?? null,
		expectedTokenRefreshedAt: input.joined.connection.tokenRefreshedAt,
	})
}

async function persistAuthFailureRow(input: {
	env: Env
	userId: string
	name: string
	lane: 'user' | 'platform'
	accountLabel: string | null
	reason: IntegrationAuthFailureReason
	providerError?: string | null
	providerErrorDescription?: string | null
	httpStatus?: number | null
	expectedTokenRefreshedAt: string | null
}) {
	const copy = integrationAuthFailureCopy({
		name: input.name,
		accountLabel: input.accountLabel,
		lane: input.lane,
		reason: input.reason,
	})
	try {
		await writeIntegrationAuthFailure({
			db: input.env.APP_DB,
			userId: input.userId,
			name: input.name,
			reason: input.reason,
			providerError: input.providerError,
			providerErrorDescription: input.providerErrorDescription,
			httpStatus: input.httpStatus,
			reconnectable: copy.reconnectable,
			expectedTokenRefreshedAt: input.expectedTokenRefreshedAt,
		})
	} catch (error) {
		console.warn('integration auth failure snapshot persist failed', {
			integrationName: input.name,
			error,
		})
	}
}

function isProviderTimeoutError(error: unknown) {
	if (!(error instanceof Error)) return false
	if (error.name === 'TimeoutError' || error.name === 'AbortError') return true
	const message = error.message.toLowerCase()
	return message.includes('timeout') || message.includes('timed out')
}
