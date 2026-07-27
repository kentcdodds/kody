import { type AccountIntegrationsLoaderData } from '#app/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import {
	getJoinedIntegration,
	getOauthApp,
	listJoinedIntegrations,
	toIntegrationConfig,
	type IntegrationConfig,
} from '#worker/integrations/service.ts'
import { type UserOauthApp } from '#worker/integrations/types.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type AccountIntegrationRecord = IntegrationConfig & {
	appSlug: string
	provider: string
	appLabel: string | null
	accountLabel: string | null
	createdAt: string
	updatedAt: string
}

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
 * Convert a connectionless OAuth app (unfinished setup) into the connect-flow
 * payload shape. Secret names are defaults so reconnect can proceed; the
 * connection row is still created only after token exchange.
 */
function toAppOnlyIntegrationRecord(
	app: UserOauthApp,
): AccountIntegrationRecord {
	const providerKey = canonicalIntegrationName(app.slug) || app.slug
	return {
		name: providerKey,
		appSlug: app.slug,
		provider: app.provider,
		appLabel: app.label,
		accountLabel: null,
		tokenUrl: app.tokenUrl,
		apiBaseUrl: app.apiBaseUrl,
		flow: app.flow,
		...(typeof app.usePkce === 'boolean' ? { usePkce: app.usePkce } : {}),
		clientId: app.clientId,
		clientSecretSecretName: app.clientSecretSecretName,
		accessTokenSecretName: `${providerKey}AccessToken`,
		refreshTokenSecretName: `${providerKey}RefreshToken`,
		requiredHosts: [],
		...(app.tokenExchangeStyle
			? { tokenExchangeStyle: app.tokenExchangeStyle }
			: {}),
		authorization: app.authorizeUrl
			? {
					authorizeUrl: app.authorizeUrl,
					scopes: [],
					scopeSeparator: app.scopeSeparator,
					extraAuthorizeParams: app.extraAuthorizeParams,
				}
			: null,
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
	}
}

export async function loadAccountIntegrationsData(
	env: Env,
	user: AuthenticatedUser,
): Promise<AccountIntegrationsLoaderData> {
	const joined = await listJoinedIntegrations({
		env,
		userId: user.mcpUser.userId,
	})
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
	}
}

export async function loadAccountIntegrationByName(
	env: Env,
	user: AuthenticatedUser,
	name: string,
): Promise<AccountIntegrationRecord | null> {
	const joined = await getJoinedIntegration({
		env,
		userId: user.mcpUser.userId,
		name,
	})
	if (joined) return toAccountIntegrationRecord(joined)

	// Unfinished setup persists an app with no connection. Surface it for the
	// connect flow so a later session still sees the entered client id.
	const app = await getOauthApp({
		env,
		userId: user.mcpUser.userId,
		slug: name,
	})
	if (!app) return null
	return toAppOnlyIntegrationRecord(app)
}
