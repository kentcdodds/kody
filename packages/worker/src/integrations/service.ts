import {
	canonicalIntegrationName,
	integrationConfigSchema,
	normalizeIntegrationConfig,
	type IntegrationConfig,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import {
	countConnectionsForApp,
	deleteIntegrationConnection,
	deleteOauthApp,
	findOauthAppByAppTuple,
	findOauthAppByClientCredentials,
	getJoinedIntegrationByName,
	getOauthAppBySlug,
	listJoinedIntegrationsForUser,
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

export type { IntegrationConfig }

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

export async function listIntegrations(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<IntegrationConfig>> {
	const rows = await listJoinedIntegrationsForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows.map(({ app, connection }) => toIntegrationConfig(app, connection))
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
	return toIntegrationConfig(joined.app, joined.connection)
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

	const appRowFields = buildOauthAppRow({
		userId: input.userId,
		slug: config.name,
		config,
		label: null,
		createdAt: now,
		updatedAt: now,
	})
	const matchedApp = await findOauthAppByAppTuple({
		db: input.env.APP_DB,
		userId: input.userId,
		clientId: appRowFields.client_id,
		clientSecretSecretName: appRowFields.client_secret_secret_name,
		tokenUrl: appRowFields.token_url,
		authorizeUrl: appRowFields.authorize_url,
		apiBaseUrl: appRowFields.api_base_url,
		flow: appRowFields.flow,
		usePkce: appRowFields.use_pkce,
		tokenExchangeStyle: appRowFields.token_exchange_style,
		scopeSeparator: appRowFields.scope_separator,
		extraAuthorizeParamsJson: appRowFields.extra_authorize_params_json,
	})

	let appSlug: string
	if (matchedApp) {
		appSlug = matchedApp.slug
		await upsertOauthApp({
			db: input.env.APP_DB,
			row: {
				...appRowFields,
				slug: matchedApp.slug,
				label: matchedApp.label,
				created_at: matchedApp.createdAt,
				updated_at: now,
			},
		})
	} else if (existing) {
		const siblingCount = await countConnectionsForApp({
			db: input.env.APP_DB,
			userId: input.userId,
			appSlug: existing.app.slug,
		})
		if (siblingCount <= 1) {
			appSlug = existing.app.slug
			await upsertOauthApp({
				db: input.env.APP_DB,
				row: {
					...appRowFields,
					slug: existing.app.slug,
					label: existing.app.label,
					created_at: existing.app.createdAt,
					updated_at: now,
				},
			})
		} else {
			appSlug = await allocateAppSlug({
				db: input.env.APP_DB,
				userId: input.userId,
				preferredSlug: config.name,
			})
			await upsertOauthApp({
				db: input.env.APP_DB,
				row: {
					...appRowFields,
					slug: appSlug,
					label: null,
					created_at: now,
					updated_at: now,
				},
			})
		}
	} else {
		appSlug = await allocateAppSlug({
			db: input.env.APP_DB,
			userId: input.userId,
			preferredSlug: config.name,
		})
		await upsertOauthApp({
			db: input.env.APP_DB,
			row: {
				...appRowFields,
				slug: appSlug,
				label: null,
				created_at: now,
				updated_at: now,
			},
		})
	}

	await upsertIntegrationConnection({
		db: input.env.APP_DB,
		row: {
			user_id: input.userId,
			name: config.name,
			app_slug: appSlug,
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
	const remaining = await countConnectionsForApp({
		db: input.env.APP_DB,
		userId: input.userId,
		appSlug: existing.app.slug,
	})
	if (remaining === 0) {
		await deleteOauthApp({
			db: input.env.APP_DB,
			userId: input.userId,
			slug: existing.app.slug,
		})
	}
	return true
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

function buildOauthAppRow(input: {
	userId: string
	slug: string
	config: IntegrationConfig
	label: string | null
	createdAt: string
	updatedAt: string
}) {
	const provider = providerFromSlug(input.slug)
	const authorization = input.config.authorization ?? null
	return {
		user_id: input.userId,
		slug: input.slug,
		provider,
		label: input.label,
		client_id: input.config.clientId,
		client_secret_secret_name: input.config.clientSecretSecretName ?? null,
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
		token_exchange_style: input.config.tokenExchangeStyle ?? null,
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
