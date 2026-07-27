import { type AccountIntegrationsLoaderData } from '#app/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import {
	findOauthAppForProviderSetup,
	getJoinedIntegration,
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
 * Convert an OAuth app (connectionless setup, or family fallback for a new
 * account name) into the connect-flow payload shape. `requestedName` is the
 * connection name being set up — it may differ from `app.slug` when the app
 * was reused across accounts. Secret names are defaults for the new
 * connection; the connection row is still created only after token exchange.
 */
function toAppOnlyIntegrationRecord(
	app: UserOauthApp,
	requestedName: string,
): AccountIntegrationRecord {
	const providerKey =
		canonicalIntegrationName(requestedName) ||
		canonicalIntegrationName(app.slug) ||
		app.slug
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
	// 1. Existing connection (reconnect) — connection name, not app slug.
	const joined = await getJoinedIntegration({
		env,
		userId: user.mcpUser.userId,
		name,
	})
	if (joined) return toAccountIntegrationRecord(joined)

	// 2–3. Exact app slug, else unambiguous provider-family app (shared-app
	// multi-account setup where slug may be `google` for `google-calendar`).
	const app = await findOauthAppForProviderSetup({
		env,
		userId: user.mcpUser.userId,
		name,
	})
	if (!app) return null
	return toAppOnlyIntegrationRecord(app, name)
}
