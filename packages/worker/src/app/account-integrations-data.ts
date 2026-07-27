import {
	type AccountIntegrationListItem,
	type AccountOauthAppListItem,
} from '#app/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { toOauthAppPublic } from '#mcp/capabilities/integrations/oauth-app-shared.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import {
	findOauthAppForProviderSetup,
	getJoinedIntegration,
	getOauthApp,
	listJoinedIntegrations,
	listOauthApps,
	toIntegrationConfig,
	type OauthAppSetupPrefill,
} from '#worker/integrations/service.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type AccountIntegrationRecord = AccountIntegrationListItem
export type AccountOauthAppRecord = AccountOauthAppListItem

function toAccountIntegrationRecord(input: {
	app: Parameters<typeof toIntegrationConfig>[0]
	connection: Parameters<typeof toIntegrationConfig>[1]
}): AccountIntegrationRecord {
	const config = toIntegrationConfig(input.app, input.connection)
	return {
		...config,
		appSlug: input.app.slug,
		provider: input.app.provider,
		appLabel: input.app.label,
		accountLabel: input.connection.accountLabel,
		createdAt: input.connection.createdAt,
		updatedAt: input.connection.updatedAt,
	}
}

/**
 * Convert a setup prefill (exact app, sole family member, or field-wise family
 * merge) into the connect-flow payload. `requestedName` is the connection name
 * being set up — it may differ from `prefill.slug` when the app was reused
 * across accounts. Disagreed family fields are omitted / left empty so the UI
 * does not invent a secret name or endpoint.
 */
function toAppOnlyIntegrationRecord(
	prefill: OauthAppSetupPrefill,
	requestedName: string,
): AccountIntegrationRecord {
	const providerKey =
		canonicalIntegrationName(requestedName) ||
		canonicalIntegrationName(prefill.slug) ||
		prefill.slug
	return {
		name: providerKey,
		appSlug: prefill.slug,
		provider: prefill.provider,
		appLabel: prefill.label,
		accountLabel: null,
		tokenUrl: prefill.tokenUrl ?? '',
		apiBaseUrl: prefill.apiBaseUrl,
		...(prefill.flow ? { flow: prefill.flow } : {}),
		...(typeof prefill.usePkce === 'boolean'
			? { usePkce: prefill.usePkce }
			: {}),
		clientId: prefill.clientId ?? '',
		clientSecretSecretName: prefill.clientSecretSecretName,
		accessTokenSecretName: `${providerKey}AccessToken`,
		refreshTokenSecretName: `${providerKey}RefreshToken`,
		requiredHosts: [],
		...(prefill.tokenExchangeStyle
			? { tokenExchangeStyle: prefill.tokenExchangeStyle }
			: {}),
		authorization: prefill.authorizeUrl
			? {
					authorizeUrl: prefill.authorizeUrl,
					scopes: [],
					scopeSeparator: prefill.scopeSeparator,
					extraAuthorizeParams: prefill.extraAuthorizeParams ?? {},
				}
			: null,
		createdAt: prefill.createdAt,
		updatedAt: prefill.updatedAt,
	}
}

function buildOauthAppRecords(
	apps: Awaited<ReturnType<typeof listOauthApps>>,
	joined: Awaited<ReturnType<typeof listJoinedIntegrations>>,
): Array<AccountOauthAppRecord> {
	const connectionsByAppSlug = new Map<
		string,
		Array<{ name: string; accountLabel: string | null }>
	>()
	for (const { app, connection } of joined) {
		const existing = connectionsByAppSlug.get(app.slug) ?? []
		existing.push({
			name: connection.name,
			accountLabel: connection.accountLabel,
		})
		connectionsByAppSlug.set(app.slug, existing)
	}
	return apps
		.map((app) =>
			toOauthAppPublic(app, connectionsByAppSlug.get(app.slug) ?? []),
		)
		.sort((left, right) => left.slug.localeCompare(right.slug))
}

export async function loadAccountIntegrationsData(
	env: Env,
	user: AuthenticatedUser,
): Promise<{
	ok: true
	email: string
	username: string
	integrations: Array<AccountIntegrationRecord>
	apps: Array<AccountOauthAppRecord>
}> {
	const userId = user.mcpUser.userId
	const [joined, apps] = await Promise.all([
		listJoinedIntegrations({ env, userId }),
		listOauthApps({ env, userId }),
	])
	const integrations = joined
		.map((entry) => toAccountIntegrationRecord(entry))
		.sort((left, right) => {
			const appCompare = left.appSlug.localeCompare(right.appSlug)
			if (appCompare !== 0) return appCompare
			return left.name.localeCompare(right.name)
		})

	return {
		ok: true,
		email: user.email,
		username: user.username,
		integrations,
		apps: buildOauthAppRecords(apps, joined),
	}
}

export async function loadAccountOauthAppBySlug(
	env: Env,
	user: AuthenticatedUser,
	slug: string,
): Promise<AccountOauthAppRecord | null> {
	const userId = user.mcpUser.userId
	const app = await getOauthApp({ env, userId, slug })
	if (!app) return null
	const joined = await listJoinedIntegrations({ env, userId })
	const connections = joined
		.filter((entry) => entry.app.slug === app.slug)
		.map(({ connection }) => ({
			name: connection.name,
			accountLabel: connection.accountLabel,
		}))
	return toOauthAppPublic(
		{ ...app, connectionCount: connections.length },
		connections,
	)
}

export async function loadAccountIntegrationByName(
	env: Env,
	user: AuthenticatedUser,
	name: string,
): Promise<AccountIntegrationRecord | null> {
	// 1. Existing connection (reconnect) — connection name, not app slug.
	const joined = await getJoinedIntegration({
		env,
		userId: user.mcpUser.userId,
		name,
	})
	if (joined) return toAccountIntegrationRecord(joined)

	// 2–3. Exact app slug, else field-wise provider-family prefill (shared
	// client id across github/github-kent, shared google app, etc.).
	const prefill = await findOauthAppForProviderSetup({
		env,
		userId: user.mcpUser.userId,
		name,
	})
	if (!prefill) return null
	return toAppOnlyIntegrationRecord(prefill, name)
}
