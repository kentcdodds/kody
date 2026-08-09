import { parseJsonStringArray } from '@kody-internal/shared/json-parsing.ts'
import {
	decryptPlatformOauthClientSecret,
	encryptPlatformOauthClientSecret,
} from '#mcp/secrets/crypto.ts'
import {
	canonicalIntegrationName,
	type integrationFlowValues,
	type tokenExchangeStyleValues,
} from '#mcp/capabilities/integrations/integration-shared.ts'

/**
 * Operator-provisioned built-in OAuth apps shared across every user.
 *
 * The client secret is stored encrypted in `platform_oauth_apps` and is
 * deliberately outside the user secret store: no `{{secret:...}}` placeholder
 * can reference it, so sandboxed code has no resolution path to the shared
 * credential. `getPlatformOauthAppClientSecret` is the only decrypt accessor;
 * its callers are host-side token-exchange paths (connect flow and
 * `integration_token_refresh`). Never expose the decrypted value in capability
 * outputs, loader payloads, or logs.
 */
export type PlatformOauthApp = {
	slug: string
	provider: string
	label: string | null
	clientId: string
	hasClientSecret: boolean
	tokenUrl: string
	authorizeUrl: string
	apiBaseUrl: string | null
	flow: (typeof integrationFlowValues)[number]
	usePkce: boolean | null
	tokenExchangeStyle: (typeof tokenExchangeStyleValues)[number] | null
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string>
	allowedScopes: Array<string>
	defaultScopes: Array<string>
	requiredHosts: Array<string>
	enabled: boolean
	/** R2 key of the operator-uploaded logo asset, or null. */
	logoKey: string | null
	logoContentType: string | null
	createdAt: string
	updatedAt: string
}

export type PlatformOauthAppRow = {
	slug: string
	provider: string
	label: string | null
	client_id: string
	client_secret_encrypted: string | null
	token_url: string
	authorize_url: string
	api_base_url: string | null
	flow: (typeof integrationFlowValues)[number]
	use_pkce: number | null
	token_exchange_style: (typeof tokenExchangeStyleValues)[number] | null
	scope_separator: string | null
	extra_authorize_params_json: string
	allowed_scopes_json: string
	default_scopes_json: string
	required_hosts_json: string
	enabled: number
	logo_key: string | null
	logo_content_type: string | null
	created_at: string
	updated_at: string
}

const platformAppSelectColumns = `
	slug, provider, label, client_id, client_secret_encrypted, token_url,
	authorize_url, api_base_url, flow, use_pkce, token_exchange_style,
	scope_separator, extra_authorize_params_json, allowed_scopes_json,
	default_scopes_json, required_hosts_json, enabled, logo_key,
	logo_content_type, created_at, updated_at
`

export async function listPlatformOauthApps(input: {
	db: D1Database
	includeDisabled?: boolean
}): Promise<Array<PlatformOauthApp>> {
	const statement = input.includeDisabled
		? `SELECT ${platformAppSelectColumns} FROM platform_oauth_apps ORDER BY slug ASC`
		: `SELECT ${platformAppSelectColumns} FROM platform_oauth_apps WHERE enabled = 1 ORDER BY slug ASC`
	const result = await input.db.prepare(statement).all<PlatformOauthAppRow>()
	return (result.results ?? []).map(mapPlatformOauthAppRow)
}

/**
 * Enabled platform apps ordered by adoption (user connection count), for
 * surfaces that highlight the most-used built-ins first. Ties fall back to
 * creation order so a fresh deployment shows a stable list.
 */
export async function listTopPlatformAppsByUse(input: {
	db: D1Database
	limit: number
}): Promise<Array<PlatformOauthApp>> {
	const result = await input.db
		.prepare(
			`SELECT ${platformAppSelectColumns},
				(
					SELECT count(*) FROM user_integrations
					WHERE user_integrations.platform_app_slug = platform_oauth_apps.slug
				) AS connection_count
			FROM platform_oauth_apps
			WHERE enabled = 1
			ORDER BY connection_count DESC, created_at ASC, slug ASC
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<PlatformOauthAppRow>()
	return (result.results ?? []).map(mapPlatformOauthAppRow)
}

export async function getPlatformOauthAppBySlug(input: {
	db: D1Database
	slug: string
	includeDisabled?: boolean
}): Promise<PlatformOauthApp | null> {
	const slug = canonicalIntegrationName(input.slug)
	if (!slug) return null
	const row = await input.db
		.prepare(
			`SELECT ${platformAppSelectColumns}
			FROM platform_oauth_apps
			WHERE slug = ?${input.includeDisabled ? '' : ' AND enabled = 1'}
			LIMIT 1`,
		)
		.bind(slug)
		.first<PlatformOauthAppRow>()
	return row ? mapPlatformOauthAppRow(row) : null
}

/**
 * Every optional field is retain-on-omit: `undefined` keeps the stored value
 * on update, so a partial admin save can never silently clear the scope menu,
 * required hosts, or the stored client secret. Pass `null` (or an empty
 * array/record) to clear a field explicitly.
 */
export type PlatformOauthAppSaveInput = {
	slug: string
	provider?: string | null
	label?: string | null
	clientId: string
	/**
	 * Plaintext client secret to encrypt and store. `undefined` keeps the
	 * currently stored ciphertext; `null` clears it (public PKCE apps).
	 */
	clientSecret?: string | null
	tokenUrl: string
	authorizeUrl: string
	apiBaseUrl?: string | null
	flow: (typeof integrationFlowValues)[number]
	usePkce?: boolean | null
	tokenExchangeStyle?: (typeof tokenExchangeStyleValues)[number] | null
	scopeSeparator?: string | null
	extraAuthorizeParams?: Record<string, string>
	allowedScopes?: Array<string>
	defaultScopes?: Array<string>
	requiredHosts?: Array<string>
	enabled?: boolean
}

export async function upsertPlatformOauthApp(input: {
	db: D1Database
	env: Pick<Env, 'SECRET_STORE_KEY'>
	app: PlatformOauthAppSaveInput
}): Promise<PlatformOauthApp> {
	const slug = canonicalIntegrationName(input.app.slug)
	if (!slug) {
		throw new Error('Platform app slug must contain letters or numbers.')
	}
	const clientId = input.app.clientId.trim()
	if (!clientId) {
		throw new Error('Client id is required.')
	}
	const tokenUrl = input.app.tokenUrl.trim()
	const authorizeUrl = input.app.authorizeUrl.trim()
	if (!tokenUrl) throw new Error('Token URL is required.')
	if (!authorizeUrl) throw new Error('Authorize URL is required.')

	const existing = await getPlatformOauthAppRowBySlug({ db: input.db, slug })
	const clientSecretEncrypted =
		input.app.clientSecret === undefined
			? (existing?.client_secret_encrypted ?? null)
			: input.app.clientSecret === null || input.app.clientSecret.trim() === ''
				? null
				: await encryptPlatformOauthClientSecret(
						input.env,
						input.app.clientSecret.trim(),
					)
	const enabled =
		input.app.enabled === undefined
			? (existing?.enabled ?? 1)
			: input.app.enabled
				? 1
				: 0
	// Disabled apps may omit the secret so an agent can stage the full
	// provider config through MCP and an operator pastes credentials (and
	// enables) later; the secret becomes mandatory the moment the app is
	// reachable by users.
	if (enabled && input.app.flow === 'confidential' && !clientSecretEncrypted) {
		throw new Error(
			'Confidential flow requires a client secret before the app can be enabled. Save it with enabled: false to stage the config first.',
		)
	}

	const now = new Date().toISOString()
	const defaultScopes =
		input.app.defaultScopes === undefined
			? parseJsonStringArray(existing?.default_scopes_json ?? '[]')
			: normalizeScopes(input.app.defaultScopes)
	const allowedScopes = normalizeScopes([
		...(input.app.allowedScopes === undefined
			? parseJsonStringArray(existing?.allowed_scopes_json ?? '[]')
			: input.app.allowedScopes),
		...defaultScopes,
	])
	const usePkce =
		input.app.usePkce === undefined
			? (existing?.use_pkce ?? null)
			: input.app.usePkce == null
				? null
				: input.app.usePkce
					? 1
					: 0
	await input.db
		.prepare(
			`INSERT INTO platform_oauth_apps (
				slug, provider, label, client_id, client_secret_encrypted, token_url,
				authorize_url, api_base_url, flow, use_pkce, token_exchange_style,
				scope_separator, extra_authorize_params_json, allowed_scopes_json,
				default_scopes_json, required_hosts_json, enabled, created_at,
				updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(slug)
			DO UPDATE SET
				provider = excluded.provider,
				label = excluded.label,
				client_id = excluded.client_id,
				client_secret_encrypted = excluded.client_secret_encrypted,
				token_url = excluded.token_url,
				authorize_url = excluded.authorize_url,
				api_base_url = excluded.api_base_url,
				flow = excluded.flow,
				use_pkce = excluded.use_pkce,
				token_exchange_style = excluded.token_exchange_style,
				scope_separator = excluded.scope_separator,
				extra_authorize_params_json = excluded.extra_authorize_params_json,
				allowed_scopes_json = excluded.allowed_scopes_json,
				default_scopes_json = excluded.default_scopes_json,
				required_hosts_json = excluded.required_hosts_json,
				enabled = excluded.enabled,
				updated_at = excluded.updated_at`,
		)
		.bind(
			slug,
			input.app.provider === undefined
				? (existing?.provider ?? providerFromSlug(slug))
				: input.app.provider?.trim() || providerFromSlug(slug),
			input.app.label === undefined
				? (existing?.label ?? null)
				: input.app.label?.trim() || null,
			clientId,
			clientSecretEncrypted,
			tokenUrl,
			authorizeUrl,
			input.app.apiBaseUrl === undefined
				? (existing?.api_base_url ?? null)
				: input.app.apiBaseUrl?.trim() || null,
			input.app.flow,
			usePkce,
			input.app.tokenExchangeStyle === undefined
				? (existing?.token_exchange_style ?? null)
				: (input.app.tokenExchangeStyle ?? null),
			input.app.scopeSeparator === undefined
				? (existing?.scope_separator ?? null)
				: (input.app.scopeSeparator ?? null),
			input.app.extraAuthorizeParams === undefined
				? (existing?.extra_authorize_params_json ?? '{}')
				: JSON.stringify(input.app.extraAuthorizeParams),
			JSON.stringify(allowedScopes),
			JSON.stringify(defaultScopes),
			input.app.requiredHosts === undefined
				? (existing?.required_hosts_json ?? '[]')
				: JSON.stringify(input.app.requiredHosts),
			enabled,
			existing?.created_at ?? now,
			now,
		)
		.run()

	const saved = await getPlatformOauthAppBySlug({
		db: input.db,
		slug,
		includeDisabled: true,
	})
	if (!saved) {
		throw new Error(`Failed to save platform OAuth app "${slug}".`)
	}
	return saved
}

export async function deletePlatformOauthApp(input: {
	db: D1Database
	slug: string
}): Promise<boolean> {
	const slug = canonicalIntegrationName(input.slug)
	if (!slug) return false
	const connectionCount = await countConnectionsForPlatformApp({
		db: input.db,
		slug,
	})
	if (connectionCount > 0) {
		throw new Error(
			`Platform OAuth app "${slug}" still has ${connectionCount} user connection${connectionCount === 1 ? '' : 's'}. Disable it instead of deleting.`,
		)
	}
	const result = await input.db
		.prepare(`DELETE FROM platform_oauth_apps WHERE slug = ?`)
		.bind(slug)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function countConnectionsForPlatformApp(input: {
	db: D1Database
	slug: string
}): Promise<number> {
	const row = await input.db
		.prepare(
			`SELECT count(*) AS count
			FROM user_integrations
			WHERE platform_app_slug = ?`,
		)
		.bind(input.slug)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

/**
 * Decrypts the shared client secret for host-side token exchange. This is the
 * only decrypt path; keep its callers limited to the connect-flow exchange and
 * the `integration_token_refresh` capability, and never place the returned
 * value in a response, capability output, or log.
 */
export async function getPlatformOauthAppClientSecret(input: {
	db: D1Database
	env: Pick<Env, 'SECRET_STORE_KEY'>
	slug: string
}): Promise<string | null> {
	const slug = canonicalIntegrationName(input.slug)
	if (!slug) return null
	const row = await getPlatformOauthAppRowBySlug({ db: input.db, slug })
	if (!row?.client_secret_encrypted) return null
	return decryptPlatformOauthClientSecret(
		input.env,
		row.client_secret_encrypted,
	)
}

async function getPlatformOauthAppRowBySlug(input: {
	db: D1Database
	slug: string
}): Promise<PlatformOauthAppRow | null> {
	const row = await input.db
		.prepare(
			`SELECT ${platformAppSelectColumns}
			FROM platform_oauth_apps
			WHERE slug = ?
			LIMIT 1`,
		)
		.bind(input.slug)
		.first<PlatformOauthAppRow>()
	return row ?? null
}

export function mapPlatformOauthAppRow(
	row: PlatformOauthAppRow,
): PlatformOauthApp {
	return {
		slug: row.slug,
		provider: row.provider,
		label: row.label,
		clientId: row.client_id,
		hasClientSecret: row.client_secret_encrypted != null,
		tokenUrl: row.token_url,
		authorizeUrl: row.authorize_url,
		apiBaseUrl: row.api_base_url,
		flow: row.flow,
		usePkce: row.use_pkce == null ? null : row.use_pkce === 1,
		tokenExchangeStyle: row.token_exchange_style,
		scopeSeparator: row.scope_separator,
		extraAuthorizeParams: parseJsonRecord(row.extra_authorize_params_json),
		allowedScopes: parseJsonStringArray(row.allowed_scopes_json),
		defaultScopes: parseJsonStringArray(row.default_scopes_json),
		requiredHosts: parseJsonStringArray(row.required_hosts_json),
		enabled: row.enabled === 1,
		logoKey: row.logo_key ?? null,
		logoContentType: row.logo_content_type ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function normalizeScopes(scopes: Array<string>) {
	return Array.from(
		new Set(scopes.map((scope) => scope.trim()).filter(Boolean)),
	).sort((left, right) => left.localeCompare(right))
}

function providerFromSlug(slug: string) {
	const separator = slug.indexOf('-')
	return separator === -1 ? slug : slug.slice(0, separator)
}

function parseJsonRecord(raw: string): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {}
		}
		const result: Record<string, string> = {}
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === 'string') result[key] = value
		}
		return result
	} catch {
		return {}
	}
}
