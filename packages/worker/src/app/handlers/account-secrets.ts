import { jsonResponse } from '#worker/json-response.ts'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
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
	toPackageOptions,
} from '#app/account-secrets-data.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadConnectOauthNextSteps } from '#app/connect-oauth-next-steps.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { buildSecretHostApprovalUrl } from '#mcp/secrets/host-approval.ts'
import { normalizeBulkPackageSecretApprovalNames } from '#mcp/secrets/package-approval-url.ts'
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
import {
	canonicalIntegrationName,
	normalizeIntegrationConfig,
	integrationConfigSchema,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import {
	upsertIntegration,
	upsertOauthAppWithoutConnection,
} from '#worker/integrations/service.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import {
	buildOAuthTokenExchangeFailurePayload,
	buildOAuthTokenExchangeRequest,
	oauthTokenExchangeFailureHttpStatus,
	resolveTokenExchangeStyle,
	type TokenExchangeStyle,
} from '#app/oauth-token-exchange.ts'
import { readNonEmptyTrimmedString as readString } from '#app/request-body.ts'

type AccountEditableSecretScope = Extract<SecretScope, 'package' | 'user'>

type SavedPackageOption = {
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
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
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
		| typeof routes.accountSecretUserDetail
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
			if (action === 'delete') {
				return handleDeleteAction({
					request,
					env,
					user,
					body,
				})
			}
			if (action === 'save_oauth_app') {
				return handleSaveOauthAppAction({
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

async function handleSaveOauthAppAction(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	body: object
}) {
	const provider = readString(input.body, 'provider')
	const tokenUrl = readOptionalString(input.body, 'tokenUrl')
	const apiBaseUrl = readOptionalString(input.body, 'apiBaseUrl')
	const authorizeUrl = readOptionalString(input.body, 'authorizeUrl')
	const flow = readOptionalString(input.body, 'flow')
	const usePkce = readOptionalBoolean(input.body, 'usePkce')
	const clientId = readOptionalString(input.body, 'clientId')
	const clientSecretSecretName = readOptionalString(
		input.body,
		'clientSecretSecretName',
	)
	const scopeSeparator = readRawOptionalString(input.body, 'scopeSeparator')
	const extraAuthorizeParams = readStringRecord(
		input.body,
		'extraAuthorizeParams',
	)

	if (!provider) {
		return jsonResponse({ ok: false, error: 'Provider is required.' }, 400)
	}
	if (!tokenUrl) {
		return jsonResponse({ ok: false, error: 'Token URL is required.' }, 400)
	}
	if (!clientId) {
		return jsonResponse({ ok: false, error: 'Client ID is required.' }, 400)
	}
	if (flow && flow !== 'pkce' && flow !== 'confidential') {
		return jsonResponse({ ok: false, error: 'Invalid OAuth flow.' }, 400)
	}
	if (authorizeUrl) {
		const authorizeHost = safeParseHost(authorizeUrl)
		if (!authorizeHost) {
			return jsonResponse(
				{ ok: false, error: 'Authorize URL is invalid.' },
				400,
			)
		}
	}

	try {
		const app = await upsertOauthAppWithoutConnection({
			env: input.env,
			userId: input.user.mcpUser.userId,
			config: {
				name: provider,
				tokenUrl,
				apiBaseUrl,
				flow: flow === 'confidential' ? 'confidential' : 'pkce',
				...(usePkce == null ? {} : { usePkce }),
				clientId,
				clientSecretSecretName,
				tokenExchangeStyle: resolveTokenExchangeStyle({
					tokenUrl,
					tokenExchangeStyle: readOptionalString(
						input.body,
						'tokenExchangeStyle',
					),
				}),
				authorization: authorizeUrl
					? {
							authorizeUrl,
							scopes: [],
							scopeSeparator,
							extraAuthorizeParams,
						}
					: null,
			},
		})
		return jsonResponse({
			ok: true,
			app: {
				slug: app.slug,
				provider: app.provider,
				clientId: app.clientId,
				clientSecretSecretName: app.clientSecretSecretName,
				tokenUrl: app.tokenUrl,
				authorizeUrl: app.authorizeUrl,
				apiBaseUrl: app.apiBaseUrl,
				flow: app.flow,
				usePkce: app.usePkce,
				tokenExchangeStyle: app.tokenExchangeStyle,
			},
		})
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to save OAuth app configuration.',
			},
			400,
		)
	}
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
	const usePkce = readOptionalBoolean(input.body, 'usePkce')
	const clientId = readOptionalString(input.body, 'clientId')
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
	if (!clientId) {
		return jsonResponse({ ok: false, error: 'Client ID is required.' }, 400)
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
		storageContext: { sessionId: null, appId: null, packageId: null },
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
			storageContext: { sessionId: null, appId: null, packageId: null },
		})
		refreshSaved = true
	}
	const persistRefreshTokenSecretName =
		refreshTokenSecretName &&
		(refreshSaved || approvedHostsBySecretName.has(refreshTokenSecretName))
			? refreshTokenSecretName
			: null

	const integrationName = await saveIntegrationConfig({
		env: input.env,
		userId: input.user.mcpUser.userId,
		provider,
		tokenUrl,
		apiBaseUrl,
		flow: flow === 'confidential' ? 'confidential' : 'pkce',
		usePkce,
		clientId,
		clientSecretSecretName,
		accessTokenSecretName,
		refreshTokenSecretName: persistRefreshTokenSecretName,
		tokenExchangeStyle: resolveTokenExchangeStyle({
			tokenUrl,
			tokenExchangeStyle: readOptionalString(input.body, 'tokenExchangeStyle'),
		}),
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
		...(persistRefreshTokenSecretName ? [persistRefreshTokenSecretName] : []),
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

	const nextSteps = await loadConnectOauthNextSteps({
		env: input.env,
		integrationName,
		providerQuery: provider,
		baseUrl: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
	})

	return jsonResponse({
		ok: true,
		accessTokenSaved: Boolean(accessSaved),
		refreshTokenSaved: refreshSaved,
		allowedHosts,
		hostApprovalLinks,
		integrationName,
		nextSteps,
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

	const tokenExchangeStyle = resolveTokenExchangeStyle({
		tokenUrl,
		tokenExchangeStyle: readOptionalString(input.body, 'tokenExchangeStyle'),
	})

	const params = new URLSearchParams(paramsRaw)
	let clientSecret: string | null = null
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
			storageContext: { sessionId: null, appId: null, packageId: null },
		})
		if (!resolved.found || !resolved.value) {
			return jsonResponse({ ok: false, error: 'Client secret not found.' }, 400)
		}
		clientSecret = resolved.value
	}

	let exchangeRequest: { headers: Record<string, string>; body: string }
	try {
		exchangeRequest = buildOAuthTokenExchangeRequest({
			params,
			flow,
			clientSecret,
			style: tokenExchangeStyle,
		})
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to build token exchange request.',
			},
			400,
		)
	}

	const response = await fetch(tokenUrl, {
		method: 'POST',
		headers: exchangeRequest.headers,
		body: exchangeRequest.body,
	})
	const text = await response.text()
	let payload: unknown = null
	try {
		payload = JSON.parse(text)
	} catch {
		payload = null
	}
	const payloadRecord =
		payload && typeof payload === 'object' && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: null
	if (!response.ok) {
		return jsonResponse(
			buildOAuthTokenExchangeFailurePayload({
				providerStatus: response.status,
				payload: payloadRecord,
			}),
			oauthTokenExchangeFailureHttpStatus(),
		)
	}
	if (!payloadRecord) {
		return jsonResponse(
			buildOAuthTokenExchangeFailurePayload({
				providerStatus: response.status,
				payload: null,
			}),
			oauthTokenExchangeFailureHttpStatus(),
		)
	}
	return jsonResponse(payloadRecord, response.status)
}

async function saveIntegrationConfig(input: {
	env: Env
	userId: string
	provider: string
	tokenUrl: string
	apiBaseUrl: string | null
	flow: 'pkce' | 'confidential'
	usePkce: boolean | null
	clientId: string
	clientSecretSecretName: string | null
	accessTokenSecretName: string
	refreshTokenSecretName: string | null
	tokenExchangeStyle: TokenExchangeStyle | null
	allowedHosts: Array<string>
	authorization: {
		authorizeUrl: string
		scopes: Array<string>
		scopeSeparator: string | null
		extraAuthorizeParams: Record<string, string>
	} | null
}) {
	const providerKey = canonicalIntegrationName(input.provider)
	if (!providerKey) {
		throw new Error('Provider must contain letters or numbers.')
	}
	const parsed = integrationConfigSchema.safeParse({
		name: input.provider,
		tokenUrl: input.tokenUrl,
		apiBaseUrl: input.apiBaseUrl,
		flow: input.flow,
		...(input.usePkce == null ? {} : { usePkce: input.usePkce }),
		clientId: input.clientId,
		clientSecretSecretName:
			input.flow === 'confidential'
				? (input.clientSecretSecretName ?? `${providerKey}ClientSecret`)
				: null,
		accessTokenSecretName: input.accessTokenSecretName,
		refreshTokenSecretName: input.refreshTokenSecretName,
		requiredHosts: input.allowedHosts,
		...(input.tokenExchangeStyle && input.tokenExchangeStyle !== 'form'
			? { tokenExchangeStyle: input.tokenExchangeStyle }
			: {}),
		...(input.authorization ? { authorization: input.authorization } : {}),
	})
	if (!parsed.success) {
		throw new Error('OAuth integration configuration is invalid.')
	}
	const integration = await upsertIntegration({
		env: input.env,
		userId: input.userId,
		config: normalizeIntegrationConfig(parsed.data),
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

function readRequestedSecretNames(url: URL) {
	const values = [
		...url.searchParams.getAll('names'),
		...url.searchParams.getAll('name'),
	]
	return normalizeBulkPackageSecretApprovalNames(
		values.flatMap((value) => value.split(',')),
	)
}

function readRequestedCapability(url: URL) {
	const value = url.searchParams.get('capability')
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
			requestedCapability: readRequestedCapability(url),
			requestedSecretNames: readRequestedSecretNames(url),
		})

		if (approval.kind === 'package_bulk') {
			if (input.action === 'approve') {
				const savedPackages = await listSavedPackagesByUserId(
					input.env.APP_DB,
					{
						userId: input.user.mcpUser.userId,
					},
				)
				if (!savedPackages.some((entry) => entry.id === approval.packageId)) {
					return jsonResponse(
						{ ok: false, error: 'Package not found for approval.' },
						404,
					)
				}
				const current = await listSecrets({
					env: input.env,
					userId: input.user.mcpUser.userId,
					scope: 'user',
				})
				const byName = new Map(
					current
						.filter((item) => item.scope === 'user')
						.map((item) => [item.name, item]),
				)
				const missingNames: Array<string> = []
				for (const name of approval.names) {
					const secret = byName.get(name)
					if (!secret) {
						missingNames.push(name)
						continue
					}
					if (secret.allowedPackages.includes(approval.packageId)) continue
					await setSecretAllowedPackages({
						env: input.env,
						userId: input.user.mcpUser.userId,
						name,
						scope: 'user',
						allowedPackages: Array.from(
							new Set([...secret.allowedPackages, approval.packageId]),
						),
						storageContext: null,
					})
				}
				if (missingNames.length === approval.names.length) {
					return jsonResponse(
						{ ok: false, error: 'None of the listed secrets were found.' },
						404,
					)
				}
			}
			const payload = await loadAccountSecretsData({
				request: input.request,
				env: input.env,
				user: input.user,
				selectedSecretId: null,
			})
			return jsonResponse(payload)
		}

		if (approval.kind === 'package') {
			if (input.action === 'approve') {
				const savedPackages = await listSavedPackagesByUserId(
					input.env.APP_DB,
					{
						userId: input.user.mcpUser.userId,
					},
				)
				if (!savedPackages.some((entry) => entry.id === approval.packageId)) {
					return jsonResponse(
						{ ok: false, error: 'Package not found for approval.' },
						404,
					)
				}
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

		if (approval.kind === 'capability') {
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
				await setSecretAllowedCapabilities({
					env: input.env,
					userId: input.user.mcpUser.userId,
					name: approval.name,
					scope: approval.scope,
					allowedCapabilities: Array.from(
						new Set([...secret.allowedCapabilities, approval.capabilityName]),
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

		if (approval.kind === 'host') {
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
		}

		const _exhaustive: never = approval
		throw new Error(`Unsupported approval kind: ${String(_exhaustive)}`)
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
	if (scope === 'package' && allowedPackages.length > 0) {
		return jsonResponse(
			{
				ok: false,
				error: 'Package secrets are accessible only to their owning package.',
			},
			400,
		)
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
	const packageOptions = toPackageOptions(savedPackages)
	const packageId = readPackageIdForScope({
		body: input.body,
		scope,
		packageOptions,
	})
	if (scope === 'package' && !packageId) {
		return jsonResponse(
			{ ok: false, error: 'Choose a package for package secrets.' },
			400,
		)
	}

	const secrets = await listAccountSecrets({
		env: input.env,
		user: input.user,
		packageOptions,
	})
	const secretById = new Map(secrets.map((secret) => [secret.id, secret]))
	const currentSecret = currentId ? (secretById.get(currentId) ?? null) : null
	if (currentId && !currentSecret) {
		return jsonResponse({ ok: false, error: 'Secret not found.' }, 404)
	}

	const nextId = buildAccountSecretId({
		name,
		scope,
		packageId,
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
				packageId,
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
				packageId,
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
				packageId,
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
				packageId,
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
			packageOptions,
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

function readOptionalString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' ? value.trim() : null
}

function readOptionalBoolean(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'boolean' ? value : null
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
	return raw === 'package' || raw === 'user' ? raw : null
}

function readPackageIdForScope(input: {
	body: object
	scope: AccountEditableSecretScope
	packageOptions: Array<SavedPackageOption>
}) {
	if (input.scope !== 'package') return null
	const packageId = readString(input.body, 'packageId')
	if (!packageId) return null
	return input.packageOptions.some(
		(packageOption) => packageOption.id === packageId,
	)
		? packageId
		: null
}
