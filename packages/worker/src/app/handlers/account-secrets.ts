import { type BuildAction } from 'remix/fetch-router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { verifySecretHostApprovalToken } from '#mcp/secrets/host-approval.ts'
import {
	listAppSecretsByAppIds,
	listSecrets,
	setSecretAllowedHosts,
} from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { getUiArtifactByOwnerIds, listUiArtifactsByUserId } from '#mcp/ui-artifacts-repo.ts'
import { type routes } from '#app/routes.ts'

type AccountSecretListItem = {
	name: string
	scope: SecretScope
	description: string
	appId: string | null
	appTitle: string | null
	allowedHosts: Array<string>
	createdAt: string
	updatedAt: string
	ttlMs: number | null
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
	secrets: Array<AccountSecretListItem>
	approval: SecretApprovalView | null
}

type SecretApprovalAction = 'approve' | 'reject'

const approvalPathPrefix = '/account/secrets/approve'

export function createAccountSecretsHandler(env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLogin(request)
			}

			const payload = await buildAccountSecretsPayload({
				request,
				env,
				user,
			})

			return jsonResponse(payload)
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

			const action = readApprovalAction(body)
			if (!action) {
				return jsonResponse({ ok: false, error: 'Invalid approval action.' }, 400)
			}

			const token = readString(body, 'requestToken')
			if (!token) {
				return jsonResponse(
					{ ok: false, error: 'Approval request token is required.' },
					400,
				)
			}

			try {
				const approval = await verifySecretHostApprovalToken(env, token)
				if (approval.userId !== user.mcpUser.userId) {
					return jsonResponse({ ok: false, error: 'Approval request mismatch.' }, 403)
				}

				if (action === 'approve') {
				const current = await listSecrets({
					env,
					userId: user.mcpUser.userId,
						scope: approval.scope,
						secretContext: approval.secretContext,
					})
					const secret = current.find(
						(item) =>
							item.name === approval.name && item.scope === approval.scope,
					)
					if (!secret) {
						return jsonResponse({ ok: false, error: 'Secret not found.' }, 404)
					}
					await setSecretAllowedHosts({
						env,
						userId: user.mcpUser.userId,
						name: approval.name,
						scope: approval.scope,
						allowedHosts: [...secret.allowedHosts, approval.requestedHost],
						secretContext: approval.secretContext,
					})
				}

				const payload = await buildAccountSecretsPayload({
					request,
					env,
					user,
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
}): Promise<AccountSecretsPayload> {
	const url = new URL(input.request.url)
	const approvalToken = url.pathname.startsWith(approvalPathPrefix)
		? url.searchParams.get('request')
		: null

	const savedApps = await listSavedAppsForUser({
		env: input.env,
		user: input.user,
	})
	const appTitles = new Map(savedApps.map((app) => [app.id, app.title]))
	const [userSecrets, appSecrets] = await Promise.all([
		listSecrets({
			env: input.env,
			userId: input.user.mcpUser.userId,
			scope: 'user',
		}),
		listAppSecretsByAppIds({
			env: input.env,
			userId: input.user.mcpUser.userId,
			appIds: savedApps.map((app) => app.id),
		}),
	])

	const secrets = [
		...userSecrets.map((secret) => toAccountSecretListItem(secret, appTitles)),
		...Array.from(appSecrets.values())
			.flat()
			.map((secret) => toAccountSecretListItem(secret, appTitles)),
	].sort((left, right) => {
		return left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope)
	})

	const approval = approvalToken
		? await resolveSecretApprovalView({
				env: input.env,
				userId: input.user.mcpUser.userId,
				token: approvalToken,
			}).catch(() => null)
		: null

	return {
		ok: true,
		email: input.user.email,
		secrets,
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
	return apps.flat().filter((app) => {
		if (dedupedIds.has(app.id)) return false
		dedupedIds.add(app.id)
		return true
	})
}

async function resolveSecretApprovalView(input: {
	env: Env
	userId: string
	token: string
}) {
	const approval = await verifySecretHostApprovalToken(input.env, input.token)
	if (approval.userId !== input.userId) {
		throw new Error('Approval request mismatch.')
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
	return {
		name: secret.name,
		scope: secret.scope,
		description: secret.description,
		appId: secret.appId,
		appTitle: secret.appId ? (appTitles.get(secret.appId) ?? null) : null,
		allowedHosts: secret.allowedHosts,
		createdAt: secret.createdAt,
		updatedAt: secret.updatedAt,
		ttlMs: secret.ttlMs,
	} satisfies AccountSecretListItem
}

function readString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readApprovalAction(body: object): SecretApprovalAction | null {
	const raw = readString(body, 'action')
	return raw === 'approve' || raw === 'reject' ? raw : null
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
