import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import {
	canonicalIntegrationName,
	integrationConfigSchema,
	normalizeIntegrationAuthorization,
	normalizeIntegrationConfig,
	type IntegrationConfig,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import {
	getPlatformOauthAppBySlug,
	listPlatformOauthApps,
	type PlatformOauthApp,
} from './platform-apps.ts'
import {
	countConnectionsForApp,
	deleteIntegrationConnection,
	deleteOauthApp,
	findOauthAppByAppTuple,
	findOauthAppByClientCredentials,
	getJoinedIntegrationByName,
	getOauthAppBySlug,
	listJoinedIntegrationsForUser,
	listOauthAppsByProvider,
	listOauthAppsWithConnectionCounts,
	updateOauthAppClientCredentials,
	upsertIntegrationConnection,
	upsertOauthApp,
} from './repo.ts'
import {
	type JoinedIntegration,
	type UserIntegrationConnection,
	type UserOauthApp,
	type UserOauthAppWithConnectionCount,
} from './types.ts'

export type { IntegrationConfig, PlatformOauthApp }

/**
 * App-level OAuth config (no connection / token secret fields). Used by
 * connect-flow setup to persist a client id before token exchange.
 */
export type OauthAppConfigInput = {
	name: string
	tokenUrl: string
	apiBaseUrl?: string | null
	flow: IntegrationConfig['flow']
	usePkce?: boolean | null
	clientId: string
	clientSecretSecretName?: string | null
	tokenExchangeStyle?: IntegrationConfig['tokenExchangeStyle']
	authorization?: {
		authorizeUrl: string
		scopes?: Array<string>
		scopeSeparator?: string | null
		extraAuthorizeParams?: Record<string, string>
	} | null
}

type OauthAppWriteConfig = {
	name: string
	tokenUrl: string
	apiBaseUrl: string | null
	flow: IntegrationConfig['flow']
	usePkce?: boolean
	clientId: string
	clientSecretSecretName: string | null
	tokenExchangeStyle?: NonNullable<IntegrationConfig['tokenExchangeStyle']>
	authorization?: NonNullable<IntegrationConfig['authorization']>
}

export function toIntegrationConfig(
	app: UserOauthApp,
	connection: UserIntegrationConnection,
): IntegrationConfig {
	const authorization =
		app.authorizeUrl == null
			? null
			: {
					authorizeUrl: app.authorizeUrl,
					scopes: connection.scopes,
					scopeSeparator: app.scopeSeparator,
					extraAuthorizeParams: app.extraAuthorizeParams,
				}
	return normalizeIntegrationConfig({
		name: connection.name,
		tokenUrl: app.tokenUrl,
		apiBaseUrl: app.apiBaseUrl,
		flow: app.flow,
		usePkce: app.usePkce,
		clientId: app.clientId,
		clientSecretSecretName: app.clientSecretSecretName,
		accessTokenSecretName: connection.accessTokenSecretName,
		refreshTokenSecretName: connection.refreshTokenSecretName,
		requiredHosts: connection.requiredHosts,
		tokenExchangeStyle: app.tokenExchangeStyle,
		authorization,
	})
}

export function toPlatformIntegrationConfig(
	app: PlatformOauthApp,
	connection: UserIntegrationConnection,
): IntegrationConfig {
	// The shared client secret never has a user-facing secret name; the
	// `platform` marker routes sandbox token refresh through the host-side
	// `integration_token_refresh` capability instead.
	return {
		...normalizeIntegrationConfig({
			name: connection.name,
			tokenUrl: app.tokenUrl,
			apiBaseUrl: app.apiBaseUrl,
			flow: app.flow,
			usePkce: app.usePkce,
			clientId: app.clientId,
			clientSecretSecretName: null,
			accessTokenSecretName: connection.accessTokenSecretName,
			refreshTokenSecretName: connection.refreshTokenSecretName,
			requiredHosts: connection.requiredHosts,
			tokenExchangeStyle: app.tokenExchangeStyle,
			authorization: {
				authorizeUrl: app.authorizeUrl,
				scopes: connection.scopes,
				scopeSeparator: app.scopeSeparator,
				extraAuthorizeParams: app.extraAuthorizeParams,
			},
		}),
		platform: true,
	}
}

export function toJoinedIntegrationConfig(
	joined: JoinedIntegration,
): IntegrationConfig {
	switch (joined.lane) {
		case 'user':
			return toIntegrationConfig(joined.app, joined.connection)
		case 'platform':
			return toPlatformIntegrationConfig(joined.app, joined.connection)
		default: {
			const exhaustiveCheck: never = joined
			throw new Error(`Unhandled integration lane: ${String(exhaustiveCheck)}`)
		}
	}
}

export async function listIntegrations(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<IntegrationConfig>> {
	const rows = await listJoinedIntegrationsForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows.map(toJoinedIntegrationConfig)
}

export async function listJoinedIntegrations(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<JoinedIntegration>> {
	return listJoinedIntegrationsForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})
}

export async function getIntegration(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
}): Promise<IntegrationConfig | null> {
	const joined = await getJoinedIntegration({
		env: input.env,
		userId: input.userId,
		name: input.name,
	})
	if (!joined) return null
	return toJoinedIntegrationConfig(joined)
}

export async function getJoinedIntegration(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
}): Promise<JoinedIntegration | null> {
	const name = canonicalIntegrationName(input.name)
	if (!name) return null
	return getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
}

export async function upsertIntegration(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	config: IntegrationConfig
	description?: string | null
	accountLabel?: string | null
}): Promise<IntegrationConfig> {
	const parsed = integrationConfigSchema.parse(input.config)
	const config = normalizeIntegrationConfig(parsed)
	const now = new Date().toISOString()
	const existing = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name: config.name,
	})

	const { appSlug } = await resolveOrCreateOauthApp({
		db: input.env.APP_DB,
		userId: input.userId,
		config: oauthAppWriteConfigFromIntegration(config),
		existingConnectionApp: existing?.lane === 'user' ? existing.app : null,
	})

	await upsertIntegrationConnection({
		db: input.env.APP_DB,
		row: {
			user_id: input.userId,
			name: config.name,
			app_slug: appSlug,
			platform_app_slug: null,
			account_label:
				input.accountLabel === undefined
					? (existing?.connection.accountLabel ?? null)
					: input.accountLabel?.trim() || null,
			description:
				input.description === undefined
					? (existing?.connection.description ?? '')
					: (input.description?.trim() ?? ''),
			scopes_json: JSON.stringify(config.authorization?.scopes ?? []),
			required_hosts_json: JSON.stringify(
				normalizeAllowedHosts(config.requiredHosts ?? []),
			),
			access_token_secret_name: config.accessTokenSecretName,
			refresh_token_secret_name: config.refreshTokenSecretName ?? null,
			connected_at: existing?.connection.connectedAt ?? null,
			token_refreshed_at: existing?.connection.tokenRefreshedAt ?? null,
			created_at: existing?.connection.createdAt ?? now,
			updated_at: now,
		},
	})

	if (existing && existing.lane === 'user' && existing.app.slug !== appSlug) {
		await deleteOauthAppIfNoConnections({
			db: input.env.APP_DB,
			userId: input.userId,
			appSlug: existing.app.slug,
		})
	}

	const saved = await getIntegration({
		env: input.env,
		userId: input.userId,
		name: config.name,
	})
	if (!saved) {
		throw new Error(`Failed to upsert integration "${config.name}".`)
	}
	return saved
}

/**
 * Persist an OAuth app row (client id + endpoints) without creating a
 * connection. Used by the connect-oauth setup step so the client id survives
 * abandoning the flow before token exchange.
 *
 * Shares resolve/create rules with `upsertIntegration`'s app branch, including
 * full-tuple reuse and reclaiming a connectionless preferred slug when the
 * user re-runs setup with an edited client id.
 */
export async function upsertOauthAppWithoutConnection(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	config: OauthAppConfigInput
}): Promise<UserOauthApp> {
	const config = normalizeOauthAppConfig(input.config)
	const { appSlug } = await resolveOrCreateOauthApp({
		db: input.env.APP_DB,
		userId: input.userId,
		config,
		existingConnectionApp: null,
	})
	const saved = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: appSlug,
	})
	if (!saved) {
		throw new Error(`Failed to persist OAuth app "${appSlug}".`)
	}
	return saved
}

export async function deleteIntegration(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
}): Promise<boolean> {
	const name = canonicalIntegrationName(input.name)
	if (!name) return false
	const existing = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (!existing) return false
	const deleted = await deleteIntegrationConnection({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (!deleted) return false
	// Platform apps are operator-owned; deleting a built-in connection never
	// cleans up the shared app row.
	if (existing.lane === 'user') {
		await deleteOauthAppIfNoConnections({
			db: input.env.APP_DB,
			userId: input.userId,
			appSlug: existing.app.slug,
		})
	}
	return true
}

/**
 * Connect a user to a platform (built-in) OAuth app. Token secrets are the
 * user's own; only the app registration (client id + endpoints + shared
 * secret) is operator-owned.
 */
export async function upsertPlatformIntegration(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	platformAppSlug: string
	name?: string | null
	scopes: Array<string>
	accessTokenSecretName: string
	refreshTokenSecretName?: string | null
	accountLabel?: string | null
	description?: string | null
}): Promise<IntegrationConfig> {
	const app = await getPlatformOauthAppBySlug({
		db: input.env.APP_DB,
		slug: input.platformAppSlug,
	})
	if (!app) {
		throw new Error(
			`Platform integration "${input.platformAppSlug}" is not available.`,
		)
	}
	const name =
		canonicalIntegrationName(input.name?.trim() || app.slug) || app.slug
	const accessTokenSecretName = input.accessTokenSecretName.trim()
	if (!accessTokenSecretName) {
		throw new Error('Access token secret name is required.')
	}
	const scopes = assertScopesAllowedForPlatformApp(app, input.scopes)
	const tokenHost = safeParseHost(app.tokenUrl)
	const requiredHosts = normalizeAllowedHosts([
		...app.requiredHosts,
		...(tokenHost ? [tokenHost] : []),
		...(app.apiBaseUrl ? [safeParseHost(app.apiBaseUrl) ?? ''] : []),
	])

	const existing = await getJoinedIntegrationByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	const now = new Date().toISOString()
	await upsertIntegrationConnection({
		db: input.env.APP_DB,
		row: {
			user_id: input.userId,
			name,
			app_slug: null,
			platform_app_slug: app.slug,
			account_label:
				input.accountLabel === undefined
					? (existing?.connection.accountLabel ?? null)
					: input.accountLabel?.trim() || null,
			description:
				input.description === undefined
					? (existing?.connection.description ?? '')
					: (input.description?.trim() ?? ''),
			scopes_json: JSON.stringify(
				scopes.length > 0 ? scopes : app.defaultScopes,
			),
			required_hosts_json: JSON.stringify(requiredHosts),
			access_token_secret_name: accessTokenSecretName,
			refresh_token_secret_name: input.refreshTokenSecretName?.trim() || null,
			connected_at: now,
			token_refreshed_at: existing?.connection.tokenRefreshedAt ?? null,
			created_at: existing?.connection.createdAt ?? now,
			updated_at: now,
		},
	})

	// Converting an existing user-lane connection to the platform lane leaves
	// its old app row behind when it was the sole connection; clean it up the
	// same way a user-lane app switch does.
	if (existing?.lane === 'user') {
		await deleteOauthAppIfNoConnections({
			db: input.env.APP_DB,
			userId: input.userId,
			appSlug: existing.app.slug,
		})
	}

	const saved = await getIntegration({
		env: input.env,
		userId: input.userId,
		name,
	})
	if (!saved) {
		throw new Error(`Failed to save platform integration "${name}".`)
	}
	return saved
}

/**
 * The allowed-scope menu is a strict allowlist: an empty menu permits only
 * scope-less connections. Callers must run this before persisting anything
 * (including token secrets), so a rejected scope set leaves no state behind.
 * Returns the normalized requested scopes.
 */
export function assertScopesAllowedForPlatformApp(
	app: PlatformOauthApp,
	requestedScopes: Array<string>,
): Array<string> {
	const allowedScopes = new Set(app.allowedScopes)
	const scopes = Array.from(
		new Set(requestedScopes.map((scope) => scope.trim()).filter(Boolean)),
	)
	const disallowed = scopes.filter((scope) => !allowedScopes.has(scope))
	if (disallowed.length > 0) {
		throw new Error(
			`Scopes not allowed for platform integration "${app.slug}": ${disallowed.join(', ')}.`,
		)
	}
	return scopes
}

export async function listAvailablePlatformApps(input: {
	env: Pick<Env, 'APP_DB'>
}): Promise<Array<PlatformOauthApp>> {
	return listPlatformOauthApps({ db: input.env.APP_DB })
}

export async function getAvailablePlatformApp(input: {
	env: Pick<Env, 'APP_DB'>
	slug: string
}): Promise<PlatformOauthApp | null> {
	return getPlatformOauthAppBySlug({
		db: input.env.APP_DB,
		slug: input.slug,
	})
}

async function deleteOauthAppIfNoConnections(input: {
	db: D1Database
	userId: string
	appSlug: string
}): Promise<void> {
	const remaining = await countConnectionsForApp({
		db: input.db,
		userId: input.userId,
		appSlug: input.appSlug,
	})
	if (remaining === 0) {
		await deleteOauthApp({
			db: input.db,
			userId: input.userId,
			slug: input.appSlug,
		})
	}
}

export async function listOauthApps(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<UserOauthAppWithConnectionCount>> {
	return listOauthAppsWithConnectionCounts({
		db: input.env.APP_DB,
		userId: input.userId,
	})
}

export async function getOauthApp(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	slug: string
}): Promise<UserOauthApp | null> {
	const slug = canonicalizeOauthAppSlug(input.slug)
	if (!slug) return null
	return getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
}

/**
 * App-level fields the connect-flow setup UI can prefill. Exact slug / sole
 * family member returns every field from that app. Multi-app family fallback
 * fills each field only when every candidate agrees; disagreed fields are
 * null so the UI does not invent a secret name or endpoint.
 */
export type OauthAppSetupPrefill = {
	userId: string
	slug: string
	provider: string
	label: string | null
	clientId: string | null
	clientSecretSecretName: string | null
	tokenUrl: string | null
	authorizeUrl: string | null
	apiBaseUrl: string | null
	flow: UserOauthApp['flow'] | null
	usePkce: boolean | null
	tokenExchangeStyle: UserOauthApp['tokenExchangeStyle']
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string> | null
	createdAt: string
	updatedAt: string
}

/**
 * Resolve an OAuth app for connect-flow setup when there is no connection
 * named `name` yet. Exact slug match first; otherwise the provider family
 * derived via `providerFromSlug` (e.g. `google-calendar` → `google`).
 *
 * Family fallback merges field-by-field: a field is prefilled only when every
 * candidate agrees on it (e.g. shared `clientId` with differing secret names
 * still prefills the client id and leaves the secret name empty).
 */
export async function findOauthAppForProviderSetup(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
}): Promise<OauthAppSetupPrefill | null> {
	const slug = canonicalizeOauthAppSlug(input.name)
	if (!slug) return null

	const exact = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
	if (exact) return oauthAppToSetupPrefill(exact)

	const family = providerFromSlug(slug)
	const candidates = await listOauthAppsByProvider({
		db: input.env.APP_DB,
		userId: input.userId,
		provider: family,
	})
	if (candidates.length === 0) return null
	if (candidates.length === 1) {
		const sole = candidates[0]
		return sole ? oauthAppToSetupPrefill(sole) : null
	}

	const merged = mergeOauthAppFamilyPrefill({
		userId: input.userId,
		family,
		candidates,
	})
	return setupPrefillHasAgreedField(merged) ? merged : null
}

function oauthAppToSetupPrefill(app: UserOauthApp): OauthAppSetupPrefill {
	return {
		userId: app.userId,
		slug: app.slug,
		provider: app.provider,
		label: app.label,
		clientId: app.clientId,
		clientSecretSecretName: app.clientSecretSecretName,
		tokenUrl: app.tokenUrl,
		authorizeUrl: app.authorizeUrl,
		apiBaseUrl: app.apiBaseUrl,
		flow: app.flow,
		usePkce: app.usePkce,
		tokenExchangeStyle: app.tokenExchangeStyle,
		scopeSeparator: app.scopeSeparator,
		extraAuthorizeParams: app.extraAuthorizeParams,
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
	}
}

function mergeOauthAppFamilyPrefill(input: {
	userId: string
	family: string
	candidates: Array<UserOauthApp>
}): OauthAppSetupPrefill {
	const { candidates, family, userId } = input
	const first = candidates[0]
	if (!first) {
		throw new Error(
			'mergeOauthAppFamilyPrefill requires at least one candidate.',
		)
	}
	return {
		userId,
		slug: family,
		provider: family,
		label: null,
		clientId: agreedSetupValue(candidates.map((app) => app.clientId)),
		clientSecretSecretName: agreedSetupValue(
			candidates.map((app) => app.clientSecretSecretName),
		),
		tokenUrl: agreedSetupValue(candidates.map((app) => app.tokenUrl)),
		authorizeUrl: agreedSetupValue(candidates.map((app) => app.authorizeUrl)),
		apiBaseUrl: agreedSetupValue(candidates.map((app) => app.apiBaseUrl)),
		flow: agreedSetupValue(candidates.map((app) => app.flow)),
		usePkce: agreedSetupValue(candidates.map((app) => app.usePkce)),
		tokenExchangeStyle: agreedSetupValue(
			candidates.map((app) => app.tokenExchangeStyle),
		),
		scopeSeparator: agreedSetupValue(
			candidates.map((app) => app.scopeSeparator),
		),
		extraAuthorizeParams: agreedSetupValue(
			candidates.map((app) => app.extraAuthorizeParams),
			sameExtraAuthorizeParams,
		),
		createdAt: first.createdAt,
		updatedAt: first.updatedAt,
	}
}

function agreedSetupValue<T>(
	values: Array<T>,
	equal: (left: T, right: T) => boolean = Object.is,
): T | null {
	const first = values[0]
	if (first === undefined) return null
	return values.every((value) => equal(value, first)) ? first : null
}

function sameExtraAuthorizeParams(
	left: Record<string, string>,
	right: Record<string, string>,
) {
	return JSON.stringify(left) === JSON.stringify(right)
}

function setupPrefillHasAgreedField(prefill: OauthAppSetupPrefill) {
	return Boolean(
		prefill.clientId ||
		prefill.clientSecretSecretName ||
		prefill.tokenUrl ||
		prefill.authorizeUrl ||
		prefill.apiBaseUrl ||
		prefill.flow ||
		typeof prefill.usePkce === 'boolean' ||
		prefill.tokenExchangeStyle ||
		prefill.scopeSeparator ||
		(prefill.extraAuthorizeParams &&
			Object.keys(prefill.extraAuthorizeParams).length > 0),
	)
}

export async function rotateOauthAppClientCredentials(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	slug: string
	clientId: string
	clientSecretSecretName?: string | null
}): Promise<UserOauthApp> {
	const slug = canonicalizeOauthAppSlug(input.slug)
	const clientId = input.clientId.trim()
	if (!slug) throw new Error('OAuth app slug is required.')
	if (!clientId) throw new Error('Client id is required.')
	const clientSecretSecretName =
		input.clientSecretSecretName == null
			? null
			: input.clientSecretSecretName.trim() || null

	const existing = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
	if (!existing) {
		throw new Error(`OAuth app "${slug}" was not found for this user.`)
	}

	const conflicting = await findOauthAppByClientCredentials({
		db: input.env.APP_DB,
		userId: input.userId,
		clientId,
		clientSecretSecretName,
	})
	if (conflicting && conflicting.slug !== slug) {
		throw new Error(
			`Another OAuth app ("${conflicting.slug}") already uses these client credentials.`,
		)
	}

	const updated = await updateOauthAppClientCredentials({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
		clientId,
		clientSecretSecretName,
	})
	if (!updated) {
		throw new Error(`Failed to rotate credentials for OAuth app "${slug}".`)
	}
	const app = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
	if (!app) {
		throw new Error(`OAuth app "${slug}" was not found after rotation.`)
	}
	return app
}

export async function deleteOauthAppIfUnused(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	slug: string
}): Promise<boolean> {
	const slug = canonicalizeOauthAppSlug(input.slug)
	if (!slug) return false
	const existing = await getOauthAppBySlug({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
	if (!existing) return false
	const connectionCount = await countConnectionsForApp({
		db: input.env.APP_DB,
		userId: input.userId,
		appSlug: existing.slug,
	})
	if (connectionCount > 0) {
		throw new Error(
			`OAuth app "${slug}" still has ${connectionCount} connection${connectionCount === 1 ? '' : 's'}.`,
		)
	}
	return deleteOauthApp({
		db: input.env.APP_DB,
		userId: input.userId,
		slug,
	})
}

function canonicalizeOauthAppSlug(slug: string) {
	return canonicalIntegrationName(slug.trim())
}

function oauthAppWriteConfigFromIntegration(
	config: IntegrationConfig,
): OauthAppWriteConfig {
	return {
		name: config.name,
		tokenUrl: config.tokenUrl,
		apiBaseUrl: config.apiBaseUrl ?? null,
		flow: config.flow,
		...(typeof config.usePkce === 'boolean' ? { usePkce: config.usePkce } : {}),
		clientId: config.clientId,
		clientSecretSecretName: config.clientSecretSecretName ?? null,
		...(config.tokenExchangeStyle
			? { tokenExchangeStyle: config.tokenExchangeStyle }
			: {}),
		...(config.authorization ? { authorization: config.authorization } : {}),
	}
}

function normalizeOauthAppConfig(
	value: OauthAppConfigInput,
): OauthAppWriteConfig {
	const preferredSlug = canonicalIntegrationName(value.name)
	if (!preferredSlug) {
		throw new Error('Provider must contain letters or numbers.')
	}
	const clientId = value.clientId.trim()
	if (!clientId) {
		throw new Error('Client ID is required.')
	}
	const tokenUrl = value.tokenUrl.trim()
	if (!tokenUrl) {
		throw new Error('Token URL is required.')
	}
	const authorization = value.authorization
		? normalizeIntegrationAuthorization({
				authorizeUrl: value.authorization.authorizeUrl,
				scopes: value.authorization.scopes ?? [],
				scopeSeparator: value.authorization.scopeSeparator ?? null,
				extraAuthorizeParams: value.authorization.extraAuthorizeParams ?? {},
			})
		: null
	// Store usePkce only when it differs from the flow default so tuple
	// matching stays aligned with normalizeIntegrationConfig / migration.
	const usePkce =
		typeof value.usePkce === 'boolean' &&
		value.usePkce !== (value.flow === 'pkce')
			? value.usePkce
			: null
	const tokenExchangeStyle = value.tokenExchangeStyle ?? null
	return {
		name: preferredSlug,
		tokenUrl,
		apiBaseUrl: value.apiBaseUrl?.trim() || null,
		flow: value.flow,
		...(usePkce == null ? {} : { usePkce }),
		clientId,
		clientSecretSecretName: value.clientSecretSecretName?.trim() || null,
		...(tokenExchangeStyle ? { tokenExchangeStyle } : {}),
		...(authorization ? { authorization } : {}),
	}
}

/**
 * Resolve or create the OAuth app row for this config. Shared by
 * `upsertIntegration` (then attaches a connection) and
 * `upsertOauthAppWithoutConnection` (setup with zero connections).
 */
async function resolveOrCreateOauthApp(input: {
	db: D1Database
	userId: string
	config: OauthAppWriteConfig
	existingConnectionApp: UserOauthApp | null
}): Promise<{ appSlug: string }> {
	const now = new Date().toISOString()
	const appTupleFields = buildOauthAppRow({
		userId: input.userId,
		slug: input.config.name,
		config: input.config,
		label: null,
		createdAt: now,
		updatedAt: now,
	})
	const matchedApp = await findOauthAppByAppTuple({
		db: input.db,
		userId: input.userId,
		clientId: appTupleFields.client_id,
		clientSecretSecretName: appTupleFields.client_secret_secret_name,
		tokenUrl: appTupleFields.token_url,
		authorizeUrl: appTupleFields.authorize_url,
		apiBaseUrl: appTupleFields.api_base_url,
		flow: appTupleFields.flow,
		usePkce: appTupleFields.use_pkce,
		tokenExchangeStyle: appTupleFields.token_exchange_style,
		scopeSeparator: appTupleFields.scope_separator,
		extraAuthorizeParamsJson: appTupleFields.extra_authorize_params_json,
	})

	if (matchedApp) {
		// Additive reuse: attach/return only. Do not rewrite slug-derived
		// identity (provider), label, created_at, or updated_at on the app.
		return { appSlug: matchedApp.slug }
	}

	if (input.existingConnectionApp) {
		const siblingCount = await countConnectionsForApp({
			db: input.db,
			userId: input.userId,
			appSlug: input.existingConnectionApp.slug,
		})
		if (siblingCount <= 1) {
			// Sole owner: update app-level fields in place, keeping slug identity.
			await upsertOauthApp({
				db: input.db,
				row: buildOauthAppRow({
					userId: input.userId,
					slug: input.existingConnectionApp.slug,
					config: input.config,
					label: input.existingConnectionApp.label,
					createdAt: input.existingConnectionApp.createdAt,
					updatedAt: now,
				}),
			})
			return { appSlug: input.existingConnectionApp.slug }
		}
	}

	const preferred = await getOauthAppBySlug({
		db: input.db,
		userId: input.userId,
		slug: input.config.name,
	})
	if (preferred) {
		const connectionCount = await countConnectionsForApp({
			db: input.db,
			userId: input.userId,
			appSlug: preferred.slug,
		})
		// An unfinished setup leaves an app with zero connections. Reuse that
		// slug when the user re-runs setup (or connects) for the same provider
		// key so we do not pile up orphan apps as they edit the client id.
		if (connectionCount === 0) {
			await upsertOauthApp({
				db: input.db,
				row: buildOauthAppRow({
					userId: input.userId,
					slug: preferred.slug,
					config: input.config,
					label: preferred.label,
					createdAt: preferred.createdAt,
					updatedAt: now,
				}),
			})
			return { appSlug: preferred.slug }
		}
	}

	const appSlug = await allocateAppSlug({
		db: input.db,
		userId: input.userId,
		preferredSlug: input.config.name,
	})
	await upsertOauthApp({
		db: input.db,
		row: buildOauthAppRow({
			userId: input.userId,
			slug: appSlug,
			config: input.config,
			label: null,
			createdAt: now,
			updatedAt: now,
		}),
	})
	return { appSlug }
}

function buildOauthAppRow(input: {
	userId: string
	slug: string
	config: OauthAppWriteConfig
	label: string | null
	createdAt: string
	updatedAt: string
}) {
	const provider = providerFromSlug(input.slug)
	const authorization = input.config.authorization ?? null
	const tokenExchangeStyle = input.config.tokenExchangeStyle ?? null
	return {
		user_id: input.userId,
		slug: input.slug,
		provider,
		label: input.label,
		client_id: input.config.clientId,
		// Client secrets are only meaningful for confidential apps; pkce rows
		// must store NULL so setup and connect tuple-match the same way.
		client_secret_secret_name:
			input.config.flow === 'confidential'
				? (input.config.clientSecretSecretName ?? null)
				: null,
		token_url: input.config.tokenUrl,
		authorize_url: authorization?.authorizeUrl ?? null,
		api_base_url: input.config.apiBaseUrl ?? null,
		flow: input.config.flow,
		use_pkce:
			typeof input.config.usePkce === 'boolean'
				? input.config.usePkce
					? 1
					: 0
				: null,
		// 'form' is the default exchange style; store NULL so migrated rows and
		// connect-flow writes share one tuple shape.
		token_exchange_style:
			tokenExchangeStyle && tokenExchangeStyle !== 'form'
				? tokenExchangeStyle
				: null,
		scope_separator: authorization?.scopeSeparator ?? null,
		extra_authorize_params_json: JSON.stringify(
			authorization?.extraAuthorizeParams ?? {},
		),
		created_at: input.createdAt,
		updated_at: input.updatedAt,
	}
}

function providerFromSlug(slug: string) {
	const separator = slug.indexOf('-')
	return separator === -1 ? slug : slug.slice(0, separator)
}

async function allocateAppSlug(input: {
	db: D1Database
	userId: string
	preferredSlug: string
}): Promise<string> {
	const existing = await getOauthAppBySlug({
		db: input.db,
		userId: input.userId,
		slug: input.preferredSlug,
	})
	if (!existing) return input.preferredSlug
	let suffix = 2
	while (suffix < 10_000) {
		const candidate = `${input.preferredSlug}-${suffix}`
		const conflict = await getOauthAppBySlug({
			db: input.db,
			userId: input.userId,
			slug: candidate,
		})
		if (!conflict) return candidate
		suffix += 1
	}
	throw new Error(
		`Unable to allocate an OAuth app slug for "${input.preferredSlug}".`,
	)
}
