import { jsonResponse } from '#worker/json-response.ts'
import {
	normalizeProviderKey,
	safeParseHost,
} from '@kody-internal/shared/url-hosts.ts'
import { type Action } from 'remix/router'
import {
	buildAccountSecretId,
	parseAccountSecretId,
} from '@kody-internal/shared/account-secret-route.ts'
import {
	getSecretContextForAccountSecret,
	listAccountSecrets,
	loadAccountSecretsData,
	readAccountSecretsSelectedSecretId,
	resolveApprovalRequest,
	toPackageAppOptions,
} from '#app/account-secrets-data.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { buildSecretHostApprovalUrl } from '#mcp/secrets/host-approval.ts'
import {
	deleteSecret,
	listSecrets,
	resolveSecret,
	saveSecret,
	setSecretAllowedCapabilities,
	setSecretAllowedHosts,
	setSecretAllowedPackages,
} from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { type routes } from '#app/routes.ts'
import { normalizeAllowedCapabilities } from '#mcp/secrets/allowed-capabilities.ts'
import { normalizeAllowedPackages } from '#mcp/secrets/allowed-packages.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import { getValue, saveValue } from '#mcp/values/service.ts'
import {
	buildIntegrationValueName,
	parseIntegrationConfig,
} from '#mcp/capabilities/integrations/integration-shared.ts'

type AccountEditableSecretScope = Extract<SecretScope, 'app' | 'user'>

type SavedPackageAppOption = {
	id: string
	title: string
	updatedAt: string
}

type ConnectOauthHostApprovalLink = {
	secretName: string
	host: string
	approvalUrl: string
}

const maxConnectOauthApprovalHosts = 10
const maxConnectOauthApprovalSecrets = 4

type SecretApprovalAction = 'approve' | 'reject'

export function createAccountSecretsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const { session } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLoginWhenUnauthenticated(request, env)
			}

			const accountSecrets = await loadAccountSecretsData({
				request,
				env,
				user,
			})
			return renderAppPage({
				request,
				env,
				title: 'Secrets',
				loaderData: { accountSecrets },
			})
		},
	} satisfies Action<
		| typeof routes.accountSecrets
		| typeof routes.accountSecretNew
		| typeof routes.accountSecretsApprove
		| typeof routes.accountSecretDetail
		| typeof routes.accountSecretUserDetail
		| typeof routes.accountSecretAppDetail
		| typeof routes.accountSecretSessionDetail
		| typeof routes.accountSecretPackageDetail
	>
}

export function createAccountSecretsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const payload = await loadAccountSecretsData({
					request,
					env,
					user,
				})
				return jsonResponse(payload)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const action = readString(body, 'action')
			if (action === 'approve' || action === 'reject') {
				return handleApprovalAction({
					request,
					env,
					user,
					action,
				})
			}
			if (action === 'save') {
				return handleSaveAction({
					request,
					env,
					user,
					body,
				})
			}
			if (action === 'value_get') {
				return handleValueGetAction({ env, user, body })
			}
			if (action === 'value_set') {
				return handleValueSetAction({ env, user, body })
			}
			if (action === 'delete') {
				return handleDeleteAction({
					request,
					env,
					user,
					body,
				})
			}
			if (action === 'connect_oauth') {
				return handleConnectOauthAction({
					request,
					env,
					user,
					body,
				})
			}
			if (action === 'oauth_exchange') {
				return handleOAuthExchangeAction({
					env,
					user,
					body,
				})
			}

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<typeof routes.accountSecretsApi>
}

async function handleValueGetAction(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	body: object
}) {
	const name = readString(input.body, 'name')
	if (!name) {
		return jsonResponse({ ok: false, error: 'Value name is required.' }, 400)
	}
	const value = await getValue({
		env: input.env,
		userId: input.user.mcpUser.userId,
		name,
		scope: 'user',
		storageContext: { sessionId: null, appId: null },
	})
	return jsonResponse({
		ok: true,
		value: value ? { value: value.value } : null,
	})
}

async function handleValueSetAction(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	body: object
}) {
	const name = readString(input.body, 'name')
	const value = readString(input.body, 'value')
	if (!name || !value) {
		return jsonResponse(
			{ ok: false, error: 'Value name and value are required.' },
			400,
		)
	}
	const description = readOptionalString(input.body, 'description') ?? ''
	const saved = await saveValue({
		env: input.env,
		userId: input.user.mcpUser.userId,
		userEmail: input.user.mcpUser.email,
		name,
		value,
		scope: 'user',
		description,
		storageContext: { sessionId: null, appId: null },
	})
	return jsonResponse({ ok: true, value: { value: saved.value } })
}

async function handleConnectOauthAction(input: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	body: object
}) {
	const provider = readString(input.body, 'provider')
	const tokenUrl = readOptionalString(input.body, 'tokenUrl')
	const apiBaseUrl = readOptionalString(input.body, 'apiBaseUrl')
	const authorizeUrl = readOptionalString(input.body, 'authorizeUrl')
	const flow = readOptionalString(input.body, 'flow')
	const clientIdValueName = readOptionalString(input.body, 'clientIdValueName')
	const clientSecretSecretName = readOptionalString(
		input.body,
		'clientSecretSecretName',
	)
	const accessTokenSecretName = readString(input.body, 'accessTokenSecretName')
	const refreshTokenSecretName = readOptionalString(
		input.body,
		'refreshTokenSecretName',
	)
	const allowedHosts = normalizeAllowedHosts(
		readStringArray(input.body, 'allowedHosts'),
	)
	const scopes = readStringArray(input.body, 'scopes')
	const scopeSeparator = readRawOptionalString(input.body, 'scopeSeparator')
	const extraAuthorizeParams = readStringRecord(
		input.body,
		'extraAuthorizeParams',
	)
	const tokenPayload =
		(input.body as Record<string, unknown>)['tokenPayload'] ?? null

	if (!provider) {
		return jsonResponse({ ok: false, error: 'Provider is required.' }, 400)
	}
	if (!tokenUrl) {
		return jsonResponse({ ok: false, error: 'Token URL is required.' }, 400)
	}
	const tokenHost = safeParseHost(tokenUrl)
	const normalizedHosts = normalizeAllowedHosts([
		...allowedHosts,
		...(tokenHost ? [tokenHost] : []),
	])
	allowedHosts.splice(0, allowedHosts.length, ...normalizedHosts)
	if (!allowedHosts.length) {
		return jsonResponse(
			{ ok: false, error: 'Allowed hosts are required.' },
			400,
		)
	}
	if (flow && flow !== 'pkce' && flow !== 'confidential') {
		return jsonResponse({ ok: false, error: 'Invalid OAuth flow.' }, 400)
	}
	if (!clientIdValueName) {
		return jsonResponse(
			{ ok: false, error: 'Client ID value name is required.' },
			400,
		)
	}
	if (!accessTokenSecretName) {
		return jsonResponse(
			{ ok: false, error: 'Access token secret name is required.' },
			400,
		)
	}
	if (!tokenPayload || typeof tokenPayload !== 'object') {
		return jsonResponse({ ok: false, error: 'Token payload is required.' }, 400)
	}
	const tokenRecord = tokenPayload as Record<string, unknown>
	const accessToken = readTokenField(tokenRecord, 'access_token')
	const refreshToken = readTokenField(tokenRecord, 'refresh_token')
	if (!accessToken) {
		return jsonResponse(
			{ ok: false, error: 'Token payload did not include an access_token.' },
			400,
		)
	}

	const approvedHostsBySecretName = new Map(
		(
			await listSecrets({
				env: input.env,
				userId: input.user.mcpUser.userId,
				scope: 'user',
				storageContext: null,
			})
		).map((secret) => [secret.name, new Set(secret.allowedHosts)]),
	)
	const accessSaved = await saveSecret({
		env: input.env,
		userId: input.user.mcpUser.userId,
		userEmail: input.user.mcpUser.email,
		name: accessTokenSecretName,
		value: accessToken,
		scope: 'user',
		description: `${provider} OAuth access token`,
		storageContext: { sessionId: null, appId: null },
	})

	let refreshSaved = false
	if (refreshToken && refreshTokenSecretName) {
		await saveSecret({
			env: input.env,
			userId: input.user.mcpUser.userId,
			userEmail: input.user.mcpUser.email,
			name: refreshTokenSecretName,
			value: refreshToken,
			scope: 'user',
			description: `${provider} OAuth refresh token`,
			storageContext: { sessionId: null, appId: null },
		})
		refreshSaved = true
	}

	const integrationName = await saveIntegrationConfig({
		env: input.env,
		userId: input.user.mcpUser.userId,
		userEmail: input.user.mcpUser.email,
		provider,
		tokenUrl,
		apiBaseUrl,
		flow: flow === 'confidential' ? 'confidential' : 'pkce',
		clientIdValueName,
		clientSecretSecretName,
		accessTokenSecretName,
		refreshTokenSecretName,
		tokenPayload: tokenRecord,
		allowedHosts,
		authorization: authorizeUrl
			? {
					authorizeUrl,
					scopes,
					scopeSeparator,
					extraAuthorizeParams,
				}
			: null,
	})
	const approvalSecretNames = [
		accessTokenSecretName,
		...(refreshSaved && refreshTokenSecretName ? [refreshTokenSecretName] : []),
	]
	let hostApprovalLinks: Array<ConnectOauthHostApprovalLink> = []
	try {
		hostApprovalLinks = await buildConnectOauthHostApprovalLinks({
			env: input.env,
			request: input.request,
			userId: input.user.mcpUser.userId,
			allowedHosts,
			secretNames: approvalSecretNames,
			approvedHostsBySecretName,
		})
	} catch (error) {
		console.error('Failed to build OAuth host approval links.', {
			userId: input.user.mcpUser.userId,
			secretNames: approvalSecretNames,
			error,
		})
	}

	return jsonResponse({
		ok: true,
		accessTokenSaved: Boolean(accessSaved),
		refreshTokenSaved: refreshSaved,
		allowedHosts,
		hostApprovalLinks,
		integrationName,
	})
}

async function buildConnectOauthHostApprovalLinks(input: {
	env: Env
	request: Request
	userId: string
	allowedHosts: Array<string>
	secretNames: Array<string>
	approvedHostsBySecretName?: Map<string, Set<string>>
}) {
	const uniqueHosts = Array.from(new Set(input.allowedHosts)).slice(
		0,
		maxConnectOauthApprovalHosts,
	)
	const uniqueSecretNames = Array.from(new Set(input.secretNames)).slice(
		0,
		maxConnectOauthApprovalSecrets,
	)
	const approvedHostsBySecretName =
		input.approvedHostsBySecretName ??
		new Map(
			(
				await listSecrets({
					env: input.env,
					userId: input.userId,
					scope: 'user',
					storageContext: null,
				})
			).map((secret) => [secret.name, new Set(secret.allowedHosts)]),
		)
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	const links = await Promise.all(
		uniqueSecretNames.flatMap((secretName) =>
			uniqueHosts.map(async (host) => {
				if (approvedHostsBySecretName.get(secretName)?.has(host)) {
					return null
				}
				return {
					secretName,
					host,
					approvalUrl: buildSecretHostApprovalUrl({
						baseUrl,
						name: secretName,
						scope: 'user',
						requestedHost: host,
						storageContext: null,
					}),
				} satisfies ConnectOauthHostApprovalLink
			}),
		),
	)
	return links
		.filter((link): link is ConnectOauthHostApprovalLink => link !== null)
		.sort((left, right) => {
			return (
				left.secretName.localeCompare(right.secretName) ||
				left.host.localeCompare(right.host)
			)
		})
}

async function handleOAuthExchangeAction(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	body: object
}) {
	const tokenUrl = readOptionalString(input.body, 'tokenUrl')
	const paramsRaw = readOptionalString(input.body, 'params')
	const flow = readOptionalString(input.body, 'flow') ?? 'pkce'
	const clientSecretSecretName = readOptionalString(
		input.body,
		'clientSecretSecretName',
	)
	const allowedHosts = normalizeAllowedHosts(
		readStringArray(input.body, 'allowedHosts'),
	)

	if (!tokenUrl) {
		return jsonResponse({ ok: false, error: 'Token URL is required.' }, 400)
	}
	if (!paramsRaw) {
		return jsonResponse({ ok: false, error: 'Token params are required.' }, 400)
	}
	if (flow !== 'pkce' && flow !== 'confidential') {
		return jsonResponse({ ok: false, error: 'Invalid OAuth flow.' }, 400)
	}
	const tokenHost = safeParseHost(tokenUrl)
	if (!tokenHost) {
		return jsonResponse({ ok: false, error: 'Token URL is invalid.' }, 400)
	}
	if (allowedHosts.length > 0 && !allowedHosts.includes(tokenHost)) {
		return jsonResponse(
			{ ok: false, error: 'Token host is not in allowed hosts.' },
			400,
		)
	}

	const params = new URLSearchParams(paramsRaw)
	if (flow === 'confidential') {
		if (!clientSecretSecretName) {
			return jsonResponse(
				{ ok: false, error: 'Client secret name is required.' },
				400,
			)
		}
		const resolved = await resolveSecret({
			env: input.env,
			userId: input.user.mcpUser.userId,
			name: clientSecretSecretName,
			scope: 'user',
			storageContext: { sessionId: null, appId: null },
		})
		if (!resolved.found || !resolved.value) {
			return jsonResponse({ ok: false, error: 'Client secret not found.' }, 400)
		}
		params.set('client_secret', resolved.value)
	}

	const response = await fetch(tokenUrl, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: params.toString(),
	})
	const text = await response.text()
	let payload: unknown = null
	try {
		payload = JSON.parse(text)
	} catch {
		payload = null
	}
	if (!payload || typeof payload !== 'object') {
		return jsonResponse(
			{ ok: false, error: 'Token exchange failed.' },
			response.status,
		)
	}
	return jsonResponse(payload as Record<string, unknown>, response.status)
}

async function saveIntegrationConfig(input: {
	env: Env
	userId: string
	userEmail: string
	provider: string
	tokenUrl: string
	apiBaseUrl: string | null
	flow: 'pkce' | 'confidential'
	clientIdValueName: string
	clientSecretSecretName: string | null
	accessTokenSecretName: string
	refreshTokenSecretName: string | null
	tokenPayload: Record<string, unknown>
	allowedHosts: Array<string>
	authorization: {
		authorizeUrl: string
		scopes: Array<string>
		scopeSeparator: string | null
		extraAuthorizeParams: Record<string, string>
	} | null
}) {
	const providerKey = normalizeProviderKey(input.provider)
	if (!providerKey) {
		throw new Error('Provider must contain letters or numbers.')
	}
	const integration = parseIntegrationConfig(
		{
			name: input.provider,
			tokenUrl: input.tokenUrl,
			apiBaseUrl: input.apiBaseUrl,
			flow: input.flow,
			clientIdValueName: input.clientIdValueName,
			clientSecretSecretName:
				input.flow === 'confidential'
					? (input.clientSecretSecretName ?? `${providerKey}ClientSecret`)
					: null,
			accessTokenSecretName: input.accessTokenSecretName,
			refreshTokenSecretName: input.refreshTokenSecretName,
			requiredHosts: input.allowedHosts,
			...(input.authorization ? { authorization: input.authorization } : {}),
		},
		input.provider,
	)
	if (!integration) {
		throw new Error('OAuth integration configuration is invalid.')
	}
	await saveValue({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		name: buildIntegrationValueName(integration.name),
		value: JSON.stringify(integration),
		scope: 'user',
		description: `OAuth integration config for ${integration.name}`,
		storageContext: { sessionId: null, appId: null },
	})
	return integration.name
}

function readTokenField(
	payload: Record<string, unknown>,
	field: string,
): string | null {
	const value = payload[field]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readApprovalHost(url: URL) {
	const value = url.searchParams.get('allowed-host')
	return value?.trim() ? value.trim() : null
}

function readRequestedPackageId(url: URL) {
	const value = url.searchParams.get('package_id')
	return value?.trim() ? value.trim() : null
}

async function handleApprovalAction(input: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	action: SecretApprovalAction
}) {
	try {
		const url = new URL(input.request.url)
		const approval = resolveApprovalRequest({
			secretId: readAccountSecretsSelectedSecretId(input.request.url),
			requestedHost: readApprovalHost(url),
			requestedPackageId: readRequestedPackageId(url),
		})

		if (approval.kind === 'package') {
			if (input.action === 'approve') {
				const current = await listSecrets({
					env: input.env,
					userId: input.user.mcpUser.userId,
					scope: approval.scope,
					storageContext: approval.storageContext,
				})
				const secret = current.find(
					(item) =>
						item.name === approval.name && item.scope === approval.scope,
				)
				if (!secret) {
					return jsonResponse({ ok: false, error: 'Secret not found.' }, 404)
				}
				await setSecretAllowedPackages({
					env: input.env,
					userId: input.user.mcpUser.userId,
					name: approval.name,
					scope: approval.scope,
					allowedPackages: Array.from(
						new Set([...secret.allowedPackages, approval.packageId]),
					),
					storageContext: approval.storageContext,
				})
			}
			const payload = await loadAccountSecretsData({
				request: input.request,
				env: input.env,
				user: input.user,
				selectedSecretId: readAccountSecretsSelectedSecretId(input.request.url),
			})
			return jsonResponse(payload)
		}

		if (input.action === 'approve') {
			const current = await listSecrets({
				env: input.env,
				userId: input.user.mcpUser.userId,
				scope: approval.scope,
				storageContext: approval.storageContext,
			})
			const secret = current.find(
				(item) => item.name === approval.name && item.scope === approval.scope,
			)
			if (!secret) {
				return jsonResponse({ ok: false, error: 'Secret not found.' }, 404)
			}
			await setSecretAllowedHosts({
				env: input.env,
				userId: input.user.mcpUser.userId,
				name: approval.name,
				scope: approval.scope,
				allowedHosts: normalizeAllowedHosts([
					...secret.allowedHosts,
					approval.requestedHost,
				]),
				storageContext: approval.storageContext,
			})
		}

		const payload = await loadAccountSecretsData({
			request: input.request,
			env: input.env,
			user: input.user,
			selectedSecretId: readAccountSecretsSelectedSecretId(input.request.url),
		})
		return jsonResponse(payload)
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to process approval request.',
			},
			400,
		)
	}
}

async function handleSaveAction(input: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	body: object
}) {
	const currentId = readOptionalString(input.body, 'currentId')
	const name = readString(input.body, 'name')
	let value = readString(input.body, 'value')
	const scope = readAccountSecretScope(input.body)
	const description = readOptionalString(input.body, 'description') ?? ''
	const allowedHosts = normalizeAllowedHosts(
		readStringArray(input.body, 'allowedHosts'),
	)
	const allowedCapabilities = normalizeAllowedCapabilities(
		readStringArray(input.body, 'allowedCapabilities'),
	)
	const allowedPackages = normalizeAllowedPackages(
		readStringArray(input.body, 'allowedPackages'),
	)

	if (!name) {
		return jsonResponse({ ok: false, error: 'Secret name is required.' }, 400)
	}
	if (!scope) {
		return jsonResponse({ ok: false, error: 'Secret scope is required.' }, 400)
	}

	if (!value && currentId) {
		const parsed = parseAccountSecretId(currentId)
		if (parsed) {
			const existing = await resolveSecret({
				env: input.env,
				userId: input.user.mcpUser.userId,
				name: parsed.name,
				scope: parsed.scope,
				storageContext: getSecretContextForAccountSecret(parsed),
			})
			if (existing.found && existing.value != null) {
				value = existing.value
			}
		}
	}

	if (!value) {
		return jsonResponse({ ok: false, error: 'Secret value is required.' }, 400)
	}

	const savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
		userId: input.user.mcpUser.userId,
	})
	const packageApps = toPackageAppOptions(savedPackages)
	const appId = readAppIdForScope({
		body: input.body,
		scope,
		packageApps,
	})
	if (scope === 'app' && !appId) {
		return jsonResponse(
			{ ok: false, error: 'Choose an app for app secrets.' },
			400,
		)
	}

	const secrets = await listAccountSecrets({
		env: input.env,
		user: input.user,
		packageApps,
	})
	const secretById = new Map(secrets.map((secret) => [secret.id, secret]))
	const currentSecret = currentId ? (secretById.get(currentId) ?? null) : null
	if (currentId && !currentSecret) {
		return jsonResponse({ ok: false, error: 'Secret not found.' }, 404)
	}

	const nextId = buildAccountSecretId({
		name,
		scope,
		appId,
	})
	if (currentId !== nextId && secretById.has(nextId)) {
		return jsonResponse(
			{
				ok: false,
				error: 'A secret with that name and scope already exists.',
			},
			409,
		)
	}

	try {
		await saveSecret({
			env: input.env,
			userId: input.user.mcpUser.userId,
			userEmail: input.user.mcpUser.email,
			name,
			value,
			scope,
			description,
			storageContext: getSecretContextForAccountSecret({
				scope,
				appId,
			}),
		})
		await setSecretAllowedHosts({
			env: input.env,
			userId: input.user.mcpUser.userId,
			name,
			scope,
			allowedHosts,
			storageContext: getSecretContextForAccountSecret({
				scope,
				appId,
			}),
		})
		await setSecretAllowedCapabilities({
			env: input.env,
			userId: input.user.mcpUser.userId,
			name,
			scope,
			allowedCapabilities,
			storageContext: getSecretContextForAccountSecret({
				scope,
				appId,
			}),
		})
		await setSecretAllowedPackages({
			env: input.env,
			userId: input.user.mcpUser.userId,
			name,
			scope,
			allowedPackages,
			storageContext: getSecretContextForAccountSecret({
				scope,
				appId,
			}),
		})

		if (currentSecret && currentSecret.id !== nextId) {
			await deleteSecret({
				env: input.env,
				userId: input.user.mcpUser.userId,
				name: currentSecret.name,
				scope: currentSecret.scope,
				storageContext: getSecretContextForAccountSecret(currentSecret),
			})
		}

		const payload = await loadAccountSecretsData({
			request: input.request,
			env: input.env,
			user: input.user,
			packageApps,
			savedPackages,
			selectedSecretId: nextId,
		})
		return jsonResponse(payload)
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error ? error.message : 'Unable to save secret.',
			},
			400,
		)
	}
}

async function handleDeleteAction(input: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	body: object
}) {
	const currentId = readString(input.body, 'currentId')
	if (!currentId) {
		return jsonResponse({ ok: false, error: 'Secret id is required.' }, 400)
	}

	const secret = parseAccountSecretId(currentId)
	if (!secret || secret.scope === 'session') {
		return jsonResponse({ ok: false, error: 'Invalid secret id.' }, 400)
	}

	const deleted = await deleteSecret({
		env: input.env,
		userId: input.user.mcpUser.userId,
		name: secret.name,
		scope: secret.scope,
		storageContext: getSecretContextForAccountSecret(secret),
	})
	if (!deleted) {
		return jsonResponse({ ok: false, error: 'Secret not found.' }, 404)
	}

	const payload = await loadAccountSecretsData({
		request: input.request,
		env: input.env,
		user: input.user,
		selectedSecretId: null,
	})
	return jsonResponse({
		...payload,
		deleted: true,
	})
}

function readString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' ? value.trim() : null
}

function readRawOptionalString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' ? value : null
}

function readStringArray(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === 'string')
}

function readStringRecord(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				(entry): entry is [string, string] => typeof entry[1] === 'string',
			)
			.map(([recordKey, recordValue]) => [recordKey, recordValue]),
	)
}

function readAccountSecretScope(
	body: object,
): AccountEditableSecretScope | null {
	const raw = readString(body, 'scope')
	return raw === 'app' || raw === 'user' ? raw : null
}

function readAppIdForScope(input: {
	body: object
	scope: AccountEditableSecretScope
	packageApps: Array<SavedPackageAppOption>
}) {
	if (input.scope !== 'app') return null
	const appId = readString(input.body, 'appId')
	if (!appId) return null
	return input.packageApps.some((app) => app.id === appId) ? appId : null
}
