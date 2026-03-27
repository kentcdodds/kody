import { type BuildAction } from 'remix/fetch-router'
import {
	buildAccountSecretId,
	parseAccountSecretId,
} from '#app/account-secret-id.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { verifySecretHostApprovalToken } from '#mcp/secrets/host-approval.ts'
import {
	deleteSecret,
	listAppSecretsByAppIds,
	listSecrets,
	resolveSecret,
	saveSecret,
	setSecretAllowedHosts,
} from '#mcp/secrets/service.ts'
import { type SecretContext, type SecretScope } from '#mcp/secrets/types.ts'
import { listUiArtifactsByUserId } from '#mcp/ui-artifacts-repo.ts'
import { type routes } from '#app/routes.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'

type AccountEditableSecretScope = Extract<SecretScope, 'app' | 'user'>

type SavedAppOption = {
	id: string
	title: string
	updatedAt: string
}

type AccountSecretListItem = {
	id: string
	name: string
	scope: AccountEditableSecretScope
	description: string
	appId: string | null
	appTitle: string | null
	allowedHosts: Array<string>
	createdAt: string
	updatedAt: string
	ttlMs: number | null
}

type AccountSecretDetail = AccountSecretListItem & {
	value: string
}

type SecretApprovalView = {
	token: string
	name: string
	scope: SecretScope
	requestedHost: string
	currentAllowedHosts: Array<string>
}

type AccountSecretsPayload = {
	ok: true
	email: string
	apps: Array<SavedAppOption>
	secrets: Array<AccountSecretListItem>
	selectedSecret: AccountSecretDetail | null
	approval: SecretApprovalView | null
}

type SecretApprovalAction = 'approve' | 'reject'

export function createAccountSecretsHandler(_env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			const { session, setCookie } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const response = render(Layout({ title: 'Secrets' }))
			if (setCookie) {
				response.headers.set('Set-Cookie', setCookie)
			}
			return response
		},
	} satisfies BuildAction<
		typeof routes.accountSecrets.method,
		typeof routes.accountSecrets.pattern
	>
}

export function createAccountSecretsApiHandler(env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const payload = await buildAccountSecretsPayload({
					request,
					env,
					user,
					selectedSecretId: readSelectedSecretId(request),
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
					body,
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

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies BuildAction<
		typeof routes.accountSecretsApi.method,
		typeof routes.accountSecretsApi.pattern
	>
}

async function buildAccountSecretsPayload(input: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	selectedSecretId?: string | null
	savedApps?: Array<SavedAppOption>
}): Promise<AccountSecretsPayload> {
	const url = new URL(input.request.url)
	const approvalToken = url.searchParams.get('request')
	const requestedApprovalHost = readApprovalHost(url)

	const savedApps =
		input.savedApps ??
		(await listSavedAppsForUser({
			env: input.env,
			user: input.user,
		}))
	const secrets = await listAccountSecrets({
		env: input.env,
		user: input.user,
		savedApps,
	})
	const selectedSecret = input.selectedSecretId
		? await resolveAccountSecretDetail({
				env: input.env,
				userId: input.user.mcpUser.userId,
				secretId: input.selectedSecretId,
				secrets,
			})
		: null

	const approval = approvalToken
		? await resolveSecretApprovalView({
				env: input.env,
				userId: input.user.mcpUser.userId,
				token: approvalToken,
				requestedHost: requestedApprovalHost,
			}).catch(() => null)
		: null

	return {
		ok: true,
		email: input.user.email,
		apps: savedApps,
		secrets,
		selectedSecret,
		approval,
	}
}

async function listSavedAppsForUser(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
}) {
	const apps = await Promise.all(
		input.user.artifactOwnerIds.map((ownerId) =>
			listUiArtifactsByUserId(input.env.APP_DB, ownerId),
		),
	)
	const dedupedIds = new Set<string>()
	return apps
		.flat()
		.filter((app) => {
			if (dedupedIds.has(app.id)) return false
			dedupedIds.add(app.id)
			return true
		})
		.map((app) => ({
			id: app.id,
			title: app.title,
			updatedAt: app.updated_at,
		}))
		.sort((left, right) => {
			return (
				right.updatedAt.localeCompare(left.updatedAt) ||
				left.title.localeCompare(right.title)
			)
		})
}

async function listAccountSecrets(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	savedApps: Array<SavedAppOption>
}) {
	const appTitles = new Map(input.savedApps.map((app) => [app.id, app.title]))
	const [userSecrets, appSecrets] = await Promise.all([
		listSecrets({
			env: input.env,
			userId: input.user.mcpUser.userId,
			scope: 'user',
		}),
		listAppSecretsByAppIds({
			env: input.env,
			userId: input.user.mcpUser.userId,
			appIds: input.savedApps.map((app) => app.id),
		}),
	])

	return [
		...userSecrets.map((secret) => toAccountSecretListItem(secret, appTitles)),
		...Array.from(appSecrets.values())
			.flat()
			.map((secret) => toAccountSecretListItem(secret, appTitles)),
	].sort((left, right) => {
		return (
			left.name.localeCompare(right.name) ||
			left.scope.localeCompare(right.scope) ||
			(left.appTitle ?? '').localeCompare(right.appTitle ?? '')
		)
	})
}

async function resolveSecretApprovalView(input: {
	env: Env
	userId: string
	token: string
	requestedHost: string | null
}) {
	const approval = await verifySecretHostApprovalToken(input.env, input.token)
	if (approval.userId !== input.userId) {
		throw new Error('Approval request mismatch.')
	}
	if (
		input.requestedHost != null &&
		approval.requestedHost !== normalizeAllowedHosts([input.requestedHost])[0]
	) {
		throw new Error('Approval request host mismatch.')
	}
	const secrets = await listSecrets({
		env: input.env,
		userId: input.userId,
		scope: approval.scope,
		secretContext: approval.secretContext,
	})
	const secret = secrets.find(
		(item) => item.name === approval.name && item.scope === approval.scope,
	)
	if (!secret) {
		throw new Error('Secret not found.')
	}
	return {
		token: input.token,
		name: approval.name,
		scope: approval.scope,
		requestedHost: approval.requestedHost,
		currentAllowedHosts: secret.allowedHosts,
	} satisfies SecretApprovalView
}

async function resolveAccountSecretDetail(input: {
	env: Env
	userId: string
	secretId: string
	secrets: Array<AccountSecretListItem>
}) {
	const parsed = parseAccountSecretId(input.secretId)
	if (!parsed) return null

	const selected = input.secrets.find((secret) => secret.id === input.secretId)
	if (!selected) return null

	const resolved = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: parsed.name,
		scope: parsed.scope,
		secretContext: getSecretContextForAccountSecret(parsed),
	})
	if (!resolved.found || resolved.value == null) return null

	return {
		...selected,
		value: resolved.value,
	} satisfies AccountSecretDetail
}

function toAccountSecretListItem(
	secret: {
		name: string
		scope: SecretScope
		description: string
		appId: string | null
		allowedHosts: Array<string>
		createdAt: string
		updatedAt: string
		ttlMs: number | null
	},
	appTitles: Map<string, string>,
) {
	if (secret.scope === 'session') {
		throw new Error('Session secrets are not editable from the account page.')
	}
	const scope = secret.scope === 'app' ? 'app' : 'user'

	return {
		id: buildAccountSecretId({
			name: secret.name,
			scope,
			appId: secret.appId,
		}),
		name: secret.name,
		scope,
		description: secret.description,
		appId: secret.appId,
		appTitle: secret.appId ? (appTitles.get(secret.appId) ?? null) : null,
		allowedHosts: secret.allowedHosts,
		createdAt: secret.createdAt,
		updatedAt: secret.updatedAt,
		ttlMs: secret.ttlMs,
	} satisfies AccountSecretListItem
}

async function handleApprovalAction(input: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	action: SecretApprovalAction
	body: object
}) {
	const token = readString(input.body, 'requestToken')
	if (!token) {
		return jsonResponse(
			{ ok: false, error: 'Approval request token is required.' },
			400,
		)
	}

	try {
		const approval = await verifySecretHostApprovalToken(input.env, token)
		if (approval.userId !== input.user.mcpUser.userId) {
			return jsonResponse(
				{ ok: false, error: 'Approval request mismatch.' },
				403,
			)
		}

		if (input.action === 'approve') {
			const current = await listSecrets({
				env: input.env,
				userId: input.user.mcpUser.userId,
				scope: approval.scope,
				secretContext: approval.secretContext,
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
				allowedHosts: [...secret.allowedHosts, approval.requestedHost],
				secretContext: approval.secretContext,
			})
		}

		const payload = await buildAccountSecretsPayload({
			request: input.request,
			env: input.env,
			user: input.user,
			selectedSecretId: readSelectedSecretId(input.request),
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
	const value = readString(input.body, 'value')
	const scope = readAccountSecretScope(input.body)
	const description = readOptionalString(input.body, 'description') ?? ''
	const allowedHosts = normalizeAllowedHosts(
		readStringArray(input.body, 'allowedHosts'),
	)

	if (!name) {
		return jsonResponse({ ok: false, error: 'Secret name is required.' }, 400)
	}
	if (!value) {
		return jsonResponse({ ok: false, error: 'Secret value is required.' }, 400)
	}
	if (!scope) {
		return jsonResponse({ ok: false, error: 'Secret scope is required.' }, 400)
	}

	const savedApps = await listSavedAppsForUser({
		env: input.env,
		user: input.user,
	})
	const appId = readAppIdForScope({
		body: input.body,
		scope,
		savedApps,
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
		savedApps,
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
			name,
			value,
			scope,
			description,
			secretContext: getSecretContextForAccountSecret({
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
			secretContext: getSecretContextForAccountSecret({
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
				secretContext: getSecretContextForAccountSecret(currentSecret),
			})
		}

		const payload = await buildAccountSecretsPayload({
			request: input.request,
			env: input.env,
			user: input.user,
			savedApps,
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
		secretContext: getSecretContextForAccountSecret(secret),
	})
	if (!deleted) {
		return jsonResponse({ ok: false, error: 'Secret not found.' }, 404)
	}

	const payload = await buildAccountSecretsPayload({
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

function getSecretContextForAccountSecret(input: {
	scope: SecretScope
	appId: string | null
	sessionId?: string | null
}): SecretContext {
	return {
		sessionId: input.scope === 'session' ? (input.sessionId ?? null) : null,
		appId: input.scope === 'app' ? input.appId : null,
	}
}

function readSelectedSecretId(request: Request) {
	return new URL(request.url).searchParams.get('selected')
}

function readApprovalHost(url: URL) {
	const value = url.searchParams.get('allowed-host')
	return value?.trim() ? value.trim() : null
}

function readString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' ? value.trim() : null
}

function readStringArray(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === 'string')
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
	savedApps: Array<SavedAppOption>
}) {
	if (input.scope !== 'app') return null
	const appId = readString(input.body, 'appId')
	if (!appId) return null
	return input.savedApps.some((app) => app.id === appId) ? appId : null
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}
