import { parseJsonStringArray } from '@kody-internal/shared/json-parsing.ts'
import {
	type UserIntegrationConnection,
	type UserIntegrationRow,
	type UserOauthApp,
	type UserOauthAppRow,
	type UserOauthAppWithConnectionCount,
} from './types.ts'

type JoinedIntegrationRow = UserOauthAppRow & {
	connection_name: string
	app_slug: string
	account_label: string | null
	description: string
	scopes_json: string
	required_hosts_json: string
	access_token_secret_name: string
	refresh_token_secret_name: string | null
	connected_at: string | null
	token_refreshed_at: string | null
	connection_created_at: string
	connection_updated_at: string
}

type UserOauthAppWithCountRow = UserOauthAppRow & {
	connection_count: number
}

const appSelectColumns = `
	user_id, slug, provider, label, client_id, client_secret_secret_name,
	token_url, authorize_url, api_base_url, flow, use_pkce, token_exchange_style,
	scope_separator, extra_authorize_params_json, created_at, updated_at
`

const joinedSelectColumns = `
	a.user_id AS user_id,
	a.slug AS slug,
	a.provider AS provider,
	a.label AS label,
	a.client_id AS client_id,
	a.client_secret_secret_name AS client_secret_secret_name,
	a.token_url AS token_url,
	a.authorize_url AS authorize_url,
	a.api_base_url AS api_base_url,
	a.flow AS flow,
	a.use_pkce AS use_pkce,
	a.token_exchange_style AS token_exchange_style,
	a.scope_separator AS scope_separator,
	a.extra_authorize_params_json AS extra_authorize_params_json,
	a.created_at AS created_at,
	a.updated_at AS updated_at,
	i.name AS connection_name,
	i.app_slug AS app_slug,
	i.account_label AS account_label,
	i.description AS description,
	i.scopes_json AS scopes_json,
	i.required_hosts_json AS required_hosts_json,
	i.access_token_secret_name AS access_token_secret_name,
	i.refresh_token_secret_name AS refresh_token_secret_name,
	i.connected_at AS connected_at,
	i.token_refreshed_at AS token_refreshed_at,
	i.created_at AS connection_created_at,
	i.updated_at AS connection_updated_at
`

export async function listJoinedIntegrationsForUser(input: {
	db: D1Database
	userId: string
}): Promise<
	Array<{ app: UserOauthApp; connection: UserIntegrationConnection }>
> {
	const result = await input.db
		.prepare(
			`SELECT ${joinedSelectColumns}
			FROM user_integrations i
			INNER JOIN user_oauth_apps a
				ON a.user_id = i.user_id AND a.slug = i.app_slug
			WHERE i.user_id = ?
			ORDER BY i.name ASC`,
		)
		.bind(input.userId)
		.all<JoinedIntegrationRow>()
	return (result.results ?? []).map(mapJoinedRow)
}

export async function getJoinedIntegrationByName(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<{
	app: UserOauthApp
	connection: UserIntegrationConnection
} | null> {
	const row = await input.db
		.prepare(
			`SELECT ${joinedSelectColumns}
			FROM user_integrations i
			INNER JOIN user_oauth_apps a
				ON a.user_id = i.user_id AND a.slug = i.app_slug
			WHERE i.user_id = ? AND i.name = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.name)
		.first<JoinedIntegrationRow>()
	return row ? mapJoinedRow(row) : null
}

export async function getOauthAppBySlug(input: {
	db: D1Database
	userId: string
	slug: string
}): Promise<UserOauthApp | null> {
	const row = await input.db
		.prepare(
			`SELECT ${appSelectColumns}
			FROM user_oauth_apps
			WHERE user_id = ? AND slug = ?
			LIMIT 1`,
		)
		.bind(input.userId, input.slug)
		.first<UserOauthAppRow>()
	return row ? mapOauthAppRow(row) : null
}

export async function listOauthAppsByProvider(input: {
	db: D1Database
	userId: string
	provider: string
}): Promise<Array<UserOauthApp>> {
	const result = await input.db
		.prepare(
			`SELECT ${appSelectColumns}
			FROM user_oauth_apps
			WHERE user_id = ? AND provider = ?
			ORDER BY slug ASC`,
		)
		.bind(input.userId, input.provider)
		.all<UserOauthAppRow>()
	return (result.results ?? []).map(mapOauthAppRow)
}

export async function findOauthAppByClientCredentials(input: {
	db: D1Database
	userId: string
	clientId: string
	clientSecretSecretName: string | null
}): Promise<UserOauthApp | null> {
	const row =
		input.clientSecretSecretName == null
			? await input.db
					.prepare(
						`SELECT ${appSelectColumns}
						FROM user_oauth_apps
						WHERE user_id = ?
							AND client_id = ?
							AND client_secret_secret_name IS NULL
						LIMIT 1`,
					)
					.bind(input.userId, input.clientId)
					.first<UserOauthAppRow>()
			: await input.db
					.prepare(
						`SELECT ${appSelectColumns}
						FROM user_oauth_apps
						WHERE user_id = ?
							AND client_id = ?
							AND client_secret_secret_name = ?
						LIMIT 1`,
					)
					.bind(input.userId, input.clientId, input.clientSecretSecretName)
					.first<UserOauthAppRow>()
	return row ? mapOauthAppRow(row) : null
}

/** Match an app only when the full app-level tuple agrees (not just credentials). */
export async function findOauthAppByAppTuple(input: {
	db: D1Database
	userId: string
	clientId: string
	clientSecretSecretName: string | null
	tokenUrl: string
	authorizeUrl: string | null
	apiBaseUrl: string | null
	flow: UserOauthAppRow['flow']
	usePkce: number | null
	tokenExchangeStyle: UserOauthAppRow['token_exchange_style']
	scopeSeparator: string | null
	extraAuthorizeParamsJson: string
}): Promise<UserOauthApp | null> {
	const row = await input.db
		.prepare(
			`SELECT ${appSelectColumns}
			FROM user_oauth_apps
			WHERE user_id = ?
				AND client_id = ?
				AND client_secret_secret_name IS ?
				AND token_url = ?
				AND authorize_url IS ?
				AND api_base_url IS ?
				AND flow = ?
				AND use_pkce IS ?
				AND token_exchange_style IS ?
				AND scope_separator IS ?
				AND extra_authorize_params_json = ?
			LIMIT 1`,
		)
		.bind(
			input.userId,
			input.clientId,
			input.clientSecretSecretName,
			input.tokenUrl,
			input.authorizeUrl,
			input.apiBaseUrl,
			input.flow,
			input.usePkce,
			input.tokenExchangeStyle,
			input.scopeSeparator,
			input.extraAuthorizeParamsJson,
		)
		.first<UserOauthAppRow>()
	return row ? mapOauthAppRow(row) : null
}

export async function listOauthAppsWithConnectionCounts(input: {
	db: D1Database
	userId: string
}): Promise<Array<UserOauthAppWithConnectionCount>> {
	const result = await input.db
		.prepare(
			`SELECT
				a.user_id, a.slug, a.provider, a.label, a.client_id,
				a.client_secret_secret_name, a.token_url, a.authorize_url,
				a.api_base_url, a.flow, a.use_pkce, a.token_exchange_style,
				a.scope_separator, a.extra_authorize_params_json,
				a.created_at, a.updated_at,
				(
					SELECT count(*)
					FROM user_integrations i
					WHERE i.user_id = a.user_id AND i.app_slug = a.slug
				) AS connection_count
			FROM user_oauth_apps a
			WHERE a.user_id = ?
			ORDER BY a.slug ASC`,
		)
		.bind(input.userId)
		.all<UserOauthAppWithCountRow>()
	return (result.results ?? []).map((row) => ({
		...mapOauthAppRow(row),
		connectionCount: Number(row.connection_count),
	}))
}

export async function countConnectionsForApp(input: {
	db: D1Database
	userId: string
	appSlug: string
}): Promise<number> {
	const row = await input.db
		.prepare(
			`SELECT count(*) AS count
			FROM user_integrations
			WHERE user_id = ? AND app_slug = ?`,
		)
		.bind(input.userId, input.appSlug)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function upsertOauthApp(input: {
	db: D1Database
	row: Omit<UserOauthAppRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO user_oauth_apps (
				user_id, slug, provider, label, client_id, client_secret_secret_name,
				token_url, authorize_url, api_base_url, flow, use_pkce,
				token_exchange_style, scope_separator, extra_authorize_params_json,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, slug)
			DO UPDATE SET
				provider = excluded.provider,
				label = excluded.label,
				client_id = excluded.client_id,
				client_secret_secret_name = excluded.client_secret_secret_name,
				token_url = excluded.token_url,
				authorize_url = excluded.authorize_url,
				api_base_url = excluded.api_base_url,
				flow = excluded.flow,
				use_pkce = excluded.use_pkce,
				token_exchange_style = excluded.token_exchange_style,
				scope_separator = excluded.scope_separator,
				extra_authorize_params_json = excluded.extra_authorize_params_json,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.row.user_id,
			input.row.slug,
			input.row.provider,
			input.row.label,
			input.row.client_id,
			input.row.client_secret_secret_name,
			input.row.token_url,
			input.row.authorize_url,
			input.row.api_base_url,
			input.row.flow,
			input.row.use_pkce,
			input.row.token_exchange_style,
			input.row.scope_separator,
			input.row.extra_authorize_params_json,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
		)
		.run()
}

export async function updateOauthAppClientCredentials(input: {
	db: D1Database
	userId: string
	slug: string
	clientId: string
	clientSecretSecretName: string | null
	updatedAt?: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`UPDATE user_oauth_apps
			SET client_id = ?,
				client_secret_secret_name = ?,
				updated_at = ?
			WHERE user_id = ? AND slug = ?`,
		)
		.bind(
			input.clientId,
			input.clientSecretSecretName,
			input.updatedAt ?? new Date().toISOString(),
			input.userId,
			input.slug,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteOauthApp(input: {
	db: D1Database
	userId: string
	slug: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`DELETE FROM user_oauth_apps
			WHERE user_id = ? AND slug = ?`,
		)
		.bind(input.userId, input.slug)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function upsertIntegrationConnection(input: {
	db: D1Database
	row: Omit<UserIntegrationRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO user_integrations (
				user_id, name, app_slug, account_label, description, scopes_json,
				required_hosts_json, access_token_secret_name, refresh_token_secret_name,
				connected_at, token_refreshed_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, name)
			DO UPDATE SET
				app_slug = excluded.app_slug,
				account_label = excluded.account_label,
				description = excluded.description,
				scopes_json = excluded.scopes_json,
				required_hosts_json = excluded.required_hosts_json,
				access_token_secret_name = excluded.access_token_secret_name,
				refresh_token_secret_name = excluded.refresh_token_secret_name,
				connected_at = excluded.connected_at,
				token_refreshed_at = excluded.token_refreshed_at,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.row.user_id,
			input.row.name,
			input.row.app_slug,
			input.row.account_label,
			input.row.description,
			input.row.scopes_json,
			input.row.required_hosts_json,
			input.row.access_token_secret_name,
			input.row.refresh_token_secret_name,
			input.row.connected_at,
			input.row.token_refreshed_at,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
		)
		.run()
}

export async function deleteIntegrationConnection(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`DELETE FROM user_integrations
			WHERE user_id = ? AND name = ?`,
		)
		.bind(input.userId, input.name)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export function mapOauthAppRow(row: UserOauthAppRow): UserOauthApp {
	return {
		userId: row.user_id,
		slug: row.slug,
		provider: row.provider,
		label: row.label,
		clientId: row.client_id,
		clientSecretSecretName: row.client_secret_secret_name,
		tokenUrl: row.token_url,
		authorizeUrl: row.authorize_url,
		apiBaseUrl: row.api_base_url,
		flow: row.flow,
		usePkce: row.use_pkce == null ? null : row.use_pkce === 1,
		tokenExchangeStyle: row.token_exchange_style,
		scopeSeparator: row.scope_separator,
		extraAuthorizeParams: parseJsonObject(row.extra_authorize_params_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export function mapIntegrationRow(
	row: UserIntegrationRow,
): UserIntegrationConnection {
	return {
		userId: row.user_id,
		name: row.name,
		appSlug: row.app_slug,
		accountLabel: row.account_label,
		description: row.description,
		scopes: parseJsonStringArray(row.scopes_json),
		requiredHosts: parseJsonStringArray(row.required_hosts_json),
		accessTokenSecretName: row.access_token_secret_name,
		refreshTokenSecretName: row.refresh_token_secret_name,
		connectedAt: row.connected_at,
		tokenRefreshedAt: row.token_refreshed_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function mapJoinedRow(row: JoinedIntegrationRow): {
	app: UserOauthApp
	connection: UserIntegrationConnection
} {
	return {
		app: mapOauthAppRow(row),
		connection: mapIntegrationRow({
			user_id: row.user_id,
			name: row.connection_name,
			app_slug: row.app_slug,
			account_label: row.account_label,
			description: row.description,
			scopes_json: row.scopes_json,
			required_hosts_json: row.required_hosts_json,
			access_token_secret_name: row.access_token_secret_name,
			refresh_token_secret_name: row.refresh_token_secret_name,
			connected_at: row.connected_at,
			token_refreshed_at: row.token_refreshed_at,
			created_at: row.connection_created_at,
			updated_at: row.connection_updated_at,
		}),
	}
}

function parseJsonObject(raw: string): Record<string, string> {
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
