import {
	type AccountIntegrationListItem,
	type AccountOauthAppListItem,
	type ConnectOauthExistingConnection,
} from '#universal/loader-data.ts'
import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { toOauthAppPublic } from '#mcp/capabilities/integrations/oauth-app-shared.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import { listSecrets } from '#mcp/secrets/service.ts'
import {
	findOauthAppForProviderSetup,
	getAvailablePlatformApp,
	getJoinedIntegration,
	getOauthApp,
	listJoinedIntegrations,
	listOauthApps,
	toJoinedIntegrationConfig,
	type OauthAppSetupPrefill,
	type PlatformOauthApp,
} from '#worker/integrations/service.ts'
import { buildPlatformOauthAppLogoPath } from '#worker/integrations/platform-app-logo.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type AccountIntegrationRecord = AccountIntegrationListItem
export type AccountOauthAppRecord = AccountOauthAppListItem

function toAccountIntegrationRecord(
	entry: JoinedIntegration,
): AccountIntegrationRecord {
	const config = toJoinedIntegrationConfig(entry)
	return {
		...config,
		appSlug: entry.app.slug,
		provider: entry.app.provider,
		appLabel: entry.app.label,
		accountLabel: entry.connection.accountLabel,
		...(entry.lane === 'platform'
			? {
					platformAllowedScopes: entry.app.allowedScopes,
					platformLogoPath: buildPlatformOauthAppLogoPath(entry.app),
					platformDescription: entry.app.description,
				}
			: {}),
		createdAt: entry.connection.createdAt,
		updatedAt: entry.connection.updatedAt,
	}
}

/**
 * Connect-flow payload for a platform (built-in) app the user has not
 * connected yet. No client credentials appear: the operator owns the app
 * registration and token exchange runs host-side.
 */
function toPlatformAppPrefillRecord(
	app: PlatformOauthApp,
	requestedName: string,
): AccountIntegrationRecord {
	const providerKey = canonicalIntegrationName(requestedName) || app.slug
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
		clientSecretSecretName: null,
		accessTokenSecretName: `${providerKey}AccessToken`,
		refreshTokenSecretName: `${providerKey}RefreshToken`,
		requiredHosts: app.requiredHosts,
		...(app.tokenExchangeStyle
			? { tokenExchangeStyle: app.tokenExchangeStyle }
			: {}),
		authorization: {
			authorizeUrl: app.authorizeUrl,
			scopes: app.defaultScopes,
			scopeSeparator: app.scopeSeparator,
			extraAuthorizeParams: app.extraAuthorizeParams,
		},
		platform: true,
		platformAllowedScopes: app.allowedScopes,
		platformLogoPath: buildPlatformOauthAppLogoPath(app),
		platformDescription: app.description,
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
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
	for (const entry of joined) {
		if (entry.lane !== 'user') continue
		const existing = connectionsByAppSlug.get(entry.app.slug) ?? []
		existing.push({
			name: entry.connection.name,
			accountLabel: entry.connection.accountLabel,
		})
		connectionsByAppSlug.set(entry.app.slug, existing)
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
		.filter((entry) => entry.lane === 'user' && entry.app.slug === app.slug)
		.map(({ connection }) => ({
			name: connection.name,
			accountLabel: connection.accountLabel,
		}))
	return toOauthAppPublic(
		{ ...app, connectionCount: connections.length },
		connections,
	)
}

/**
 * True when the record carries the endpoints the connect page needs to run
 * an authorize → token exchange flow. Records created for API use only
 * (agents typically save tokenUrl and apiBaseUrl but no authorize URL)
 * cannot, and would dead-end the page on "missing configuration".
 */
function recordCanDriveConnectFlow(record: AccountIntegrationRecord): boolean {
	return Boolean(
		record.authorization?.authorizeUrl?.trim() && record.tokenUrl?.trim(),
	)
}

export async function loadAccountIntegrationByName(
	env: Env,
	user: AuthenticatedUser,
	name: string,
	options?: {
		/**
		 * Explicit built-in intent (`platform=1` on /connect/oauth): resolve
		 * the enabled platform app directly instead of letting a complete
		 * bring-your-own record win. Falls back to the normal priority when
		 * no built-in exists for the name.
		 */
		preferPlatform?: boolean
		/**
		 * Built-in slug to resolve when it differs from the connection name
		 * (`platform=<slug>`): connecting the google built-in under the name
		 * google-2 keeps an existing bring-your-own google connection intact.
		 */
		platformSlug?: string
	},
): Promise<AccountIntegrationRecord | null> {
	// A user-lane record still wins when it can actually drive the flow (the
	// bring-your-own override); an endpoint-incomplete one defers to an
	// enabled built-in of the same name instead of dead-ending the page.
	const platformFallback = async (slug: string = name) => {
		const platformApp = await getAvailablePlatformApp({ env, slug })
		return platformApp ? toPlatformAppPrefillRecord(platformApp, name) : null
	}

	if (options?.preferPlatform || options?.platformSlug) {
		const platformRecord = await platformFallback(options.platformSlug ?? name)
		if (platformRecord) return platformRecord
	}

	// 1. Existing connection (reconnect) — connection name, not app slug.
	const joined = await getJoinedIntegration({
		env,
		userId: user.mcpUser.userId,
		name,
	})
	if (joined) {
		const record = toAccountIntegrationRecord(joined)
		if (recordCanDriveConnectFlow(record)) return record
		return (await platformFallback()) ?? record
	}

	// 2–3. Exact app slug, else field-wise provider-family prefill (shared
	// client id across github/github-kent, shared google app, etc.).
	const prefill = await findOauthAppForProviderSetup({
		env,
		userId: user.mcpUser.userId,
		name,
	})
	if (prefill) {
		const record = toAppOnlyIntegrationRecord(prefill, name)
		if (recordCanDriveConnectFlow(record)) return record
		return (await platformFallback()) ?? record
	}

	// 4. Platform (built-in) app: the user needs no OAuth app of their own, so
	// the connect flow can skip client-credential setup entirely.
	return platformFallback()
}

/**
 * The connection currently stored under `name`, summarized so the connect
 * page can warn before an OAuth flow would replace it with a different app.
 */
export async function loadExistingConnectionSummary(
	env: Env,
	user: AuthenticatedUser,
	name: string,
): Promise<ConnectOauthExistingConnection | null> {
	const joined = await getJoinedIntegration({
		env,
		userId: user.mcpUser.userId,
		name,
	})
	if (!joined) return null
	return { lane: joined.lane, appSlug: joined.app.slug }
}

/**
 * True when the user already stores the client-secret secret the connect
 * page would use for `name`: the stored integration's secret name when
 * present, else the page's default `<providerKey>ClientSecret`. Embedded in
 * loader data so the page renders its setup / ready state without a
 * follow-up secrets fetch.
 */
export async function hasStoredConnectClientSecret(
	env: Env,
	user: AuthenticatedUser,
	name: string,
	record: AccountIntegrationRecord | null,
): Promise<boolean> {
	const secretName =
		record?.clientSecretSecretName?.trim() ||
		`${normalizeProviderKey(name)}ClientSecret`
	const secrets = await listSecrets({
		env,
		userId: user.mcpUser.userId,
		scope: 'user',
	})
	return secrets.some(
		(secret) => secret.scope === 'user' && secret.name === secretName,
	)
}

/**
 * True when an enabled built-in exists for `name` that the resolved record
 * is not already using — the connect page offers it as an alternative lane.
 */
export async function hasAlternativeBuiltInApp(
	env: Env,
	name: string,
	record: AccountIntegrationRecord | null,
): Promise<boolean> {
	if (record?.platform) return false
	const platformApp = await getAvailablePlatformApp({ env, slug: name })
	return platformApp != null
}
