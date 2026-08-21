export const maxUserMcpOauthClients = 10
export const maxRedirectUris = 8
export const maxClientLabelLength = 80

export type McpOauthClientHelpers = {
	createClient(clientInfo: {
		clientName: string
		redirectUris: Array<string>
		tokenEndpointAuthMethod: 'client_secret_basic'
		grantTypes: Array<string>
		responseTypes: Array<string>
	}): Promise<{ clientId: string; clientSecret?: string }>
	deleteClient(clientId: string): Promise<void>
}

export type UserMcpOauthClientListItem = {
	id: string
	label: string
	clientId: string
	redirectUris: Array<string>
	createdAt: string
	revokedAt: string | null
}

type UserMcpOauthClientRow = {
	id: string
	client_id: string
	label: string
	redirect_uris_json: string
	created_at: string
	revoked_at: string | null
}

export function parseClientLabel(value: string | null | undefined) {
	const label = value?.trim() ?? ''
	if (!label) {
		return { ok: false as const, error: 'Enter a label for this client.' }
	}
	if (label.length > maxClientLabelLength) {
		return {
			ok: false as const,
			error: `Label must be ${maxClientLabelLength} characters or fewer.`,
		}
	}
	return { ok: true as const, label }
}

export function parseRedirectUriText(value: string | null | undefined) {
	const lines = (value ?? '')
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
	if (lines.length === 0) {
		return {
			ok: false as const,
			error: 'Enter at least one redirect URI.',
		}
	}
	if (lines.length > maxRedirectUris) {
		return {
			ok: false as const,
			error: `Enter at most ${maxRedirectUris} redirect URIs.`,
		}
	}

	const uris: Array<string> = []
	const seen = new Set<string>()
	for (const line of lines) {
		const parsed = parseRedirectUri(line)
		if (!parsed.ok) return parsed
		if (seen.has(parsed.uri)) continue
		seen.add(parsed.uri)
		uris.push(parsed.uri)
	}
	return { ok: true as const, uris }
}

function parseRedirectUri(value: string) {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return { ok: false as const, error: `Invalid redirect URI: ${value}` }
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return {
			ok: false as const,
			error: `Redirect URIs must use http or https: ${value}`,
		}
	}
	if (url.username || url.password) {
		return {
			ok: false as const,
			error: `Redirect URIs cannot include credentials: ${value}`,
		}
	}
	if (url.hash) {
		return {
			ok: false as const,
			error: `Redirect URIs cannot include a fragment: ${value}`,
		}
	}
	if (!url.hostname) {
		return { ok: false as const, error: `Invalid redirect URI: ${value}` }
	}
	return { ok: true as const, uri: url.toString() }
}

export function getOAuthClientHelpers(env: Env) {
	const helpers = (
		env as Env & {
			OAUTH_PROVIDER?: McpOauthClientHelpers
		}
	).OAUTH_PROVIDER
	if (!helpers) {
		throw new Error('OAuth provider helpers are not available.')
	}
	return helpers
}

export async function listUserMcpOauthClients(
	db: D1Database,
	userId: number,
): Promise<Array<UserMcpOauthClientListItem>> {
	const result = await db
		.prepare(
			`SELECT id, client_id, label, redirect_uris_json, created_at, revoked_at
			FROM user_mcp_oauth_clients
			WHERE user_id = ?
			ORDER BY CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END, created_at DESC`,
		)
		.bind(userId)
		.all<UserMcpOauthClientRow>()
	return (result.results ?? []).map(toListItem)
}

export async function listActiveUserMcpOauthClientIds(
	db: D1Database,
	userId: number,
): Promise<Array<string>> {
	const result = await db
		.prepare(
			`SELECT client_id FROM user_mcp_oauth_clients WHERE user_id = ? AND revoked_at IS NULL`,
		)
		.bind(userId)
		.all<{ client_id: string }>()
	return (result.results ?? []).map((row) => row.client_id)
}

export async function listOwnedUserMcpOauthClientIds(
	db: D1Database,
	userId: number,
): Promise<Array<string>> {
	const result = await db
		.prepare(`SELECT client_id FROM user_mcp_oauth_clients WHERE user_id = ?`)
		.bind(userId)
		.all<{ client_id: string }>()
	return (result.results ?? []).map((row) => row.client_id)
}

async function discardCreatedProviderClient(input: {
	db: D1Database
	helpers: McpOauthClientHelpers
	userId: number
	clientId: string
	label: string
	redirectUris: Array<string>
}) {
	try {
		await input.helpers.deleteClient(input.clientId)
	} catch {
		const now = new Date().toISOString()
		await input.db
			.prepare(
				`INSERT INTO user_mcp_oauth_clients (
					id, user_id, client_id, label, redirect_uris_json, created_at, revoked_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				input.userId,
				input.clientId,
				input.label,
				JSON.stringify(input.redirectUris),
				now,
				now,
			)
			.run()
	}
}

export async function mintUserMcpOauthClient(input: {
	db: D1Database
	helpers: McpOauthClientHelpers
	userId: number
	label: string
	redirectUris: Array<string>
}): Promise<
	| {
			ok: true
			client: UserMcpOauthClientListItem & { clientSecret: string }
	  }
	| { ok: false; error: string; status: number }
> {
	const existing = await input.db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM user_mcp_oauth_clients
			WHERE user_id = ? AND revoked_at IS NULL`,
		)
		.bind(input.userId)
		.first<{ count: number }>()
	if ((existing?.count ?? 0) >= maxUserMcpOauthClients) {
		return {
			ok: false,
			error: `You can have at most ${maxUserMcpOauthClients} active MCP OAuth clients.`,
			status: 400,
		}
	}

	const created = await input.helpers.createClient({
		clientName: input.label,
		redirectUris: input.redirectUris,
		tokenEndpointAuthMethod: 'client_secret_basic',
		grantTypes: ['authorization_code', 'refresh_token'],
		responseTypes: ['code'],
	})
	if (!created.clientSecret) {
		await discardCreatedProviderClient({
			db: input.db,
			helpers: input.helpers,
			userId: input.userId,
			clientId: created.clientId,
			label: input.label,
			redirectUris: input.redirectUris,
		})
		return {
			ok: false,
			error: 'The OAuth provider did not return a client secret.',
			status: 500,
		}
	}

	const id = crypto.randomUUID()
	const createdAt = new Date().toISOString()
	try {
		const inserted = await input.db
			.prepare(
				`INSERT INTO user_mcp_oauth_clients (
					id, user_id, client_id, label, redirect_uris_json, created_at
				)
				SELECT ?, ?, ?, ?, ?, ?
				WHERE (
					SELECT COUNT(*)
					FROM user_mcp_oauth_clients
					WHERE user_id = ? AND revoked_at IS NULL
				) < ?`,
			)
			.bind(
				id,
				input.userId,
				created.clientId,
				input.label,
				JSON.stringify(input.redirectUris),
				createdAt,
				input.userId,
				maxUserMcpOauthClients,
			)
			.run()
		if ((inserted.meta.changes ?? 0) === 0) {
			await discardCreatedProviderClient({
				db: input.db,
				helpers: input.helpers,
				userId: input.userId,
				clientId: created.clientId,
				label: input.label,
				redirectUris: input.redirectUris,
			})
			return {
				ok: false,
				error: `You can have at most ${maxUserMcpOauthClients} active MCP OAuth clients.`,
				status: 400,
			}
		}
	} catch (error) {
		await discardCreatedProviderClient({
			db: input.db,
			helpers: input.helpers,
			userId: input.userId,
			clientId: created.clientId,
			label: input.label,
			redirectUris: input.redirectUris,
		})
		throw error
	}

	return {
		ok: true,
		client: {
			id,
			label: input.label,
			clientId: created.clientId,
			clientSecret: created.clientSecret,
			redirectUris: input.redirectUris,
			createdAt,
			revokedAt: null,
		},
	}
}

export async function revokeUserMcpOauthClient(input: {
	db: D1Database
	helpers: McpOauthClientHelpers
	userId: number
	id: string
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
	const row = await input.db
		.prepare(
			`SELECT id, client_id, revoked_at
			FROM user_mcp_oauth_clients
			WHERE id = ? AND user_id = ?`,
		)
		.bind(input.id, input.userId)
		.first<{ id: string; client_id: string; revoked_at: string | null }>()
	if (!row) {
		return { ok: false, error: 'OAuth client not found.', status: 404 }
	}
	if (row.revoked_at) {
		return { ok: false, error: 'OAuth client is already revoked.', status: 400 }
	}

	await input.helpers.deleteClient(row.client_id)
	await input.db
		.prepare(
			`UPDATE user_mcp_oauth_clients
			SET revoked_at = ?
			WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		)
		.bind(new Date().toISOString(), input.id, input.userId)
		.run()
	return { ok: true }
}

export async function deleteOwnedMcpOauthClients(input: {
	db: D1Database
	helpers: Pick<McpOauthClientHelpers, 'deleteClient'>
	userId: number
	warnings: Array<string>
}): Promise<number> {
	let clientIds: Array<string>
	try {
		clientIds = await listOwnedUserMcpOauthClientIds(input.db, input.userId)
	} catch (error) {
		input.warnings.push(
			`MCP OAuth client listing failed: ${error instanceof Error ? error.message : String(error)}`,
		)
		return 0
	}

	let deleted = 0
	for (const clientId of clientIds) {
		try {
			await input.helpers.deleteClient(clientId)
			deleted += 1
		} catch (error) {
			input.warnings.push(
				`MCP OAuth client delete failed for ${clientId}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	return deleted
}

function toListItem(row: UserMcpOauthClientRow): UserMcpOauthClientListItem {
	return {
		id: row.id,
		label: row.label,
		clientId: row.client_id,
		redirectUris: parseStoredRedirectUris(row.redirect_uris_json),
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
	}
}

function parseStoredRedirectUris(value: string) {
	try {
		const parsed: unknown = JSON.parse(value)
		if (!Array.isArray(parsed)) return []
		return parsed.filter((entry) => typeof entry === 'string')
	} catch {
		return []
	}
}
