import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountSecretProvidersData } from '#app/account-secret-providers-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { isSecretProvidersEnabled } from '#mcp/secrets/secret-providers/flag.ts'
import {
	bindSecretProvider,
	grantSecretProviderToPackage,
	revokeSecretProviderGrant,
	unbindSecretProvider,
} from '#mcp/secrets/secret-providers/service.ts'

async function secretProvidersUnavailable(userId: number, env: Env) {
	return !(await isSecretProvidersEnabled({
		db: env.APP_DB,
		userId,
	}))
}

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export function createAccountSecretProvidersHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			if (await secretProvidersUnavailable(user.userId, env)) {
				return new Response('Not found.', { status: 404 })
			}
			const accountSecretProviders = await loadAccountSecretProvidersData({
				env,
				userId: user.mcpUser.userId,
				email: user.email,
				url: request.url,
			})
			return renderAppPage({
				request,
				env,
				title: 'Secret providers',
				loaderData: { accountSecretProviders },
			})
		},
	} satisfies Action<
		| typeof routes.accountSecretProviders
		| typeof routes.accountSecretProvidersApprove
	>
}

export function createAccountSecretProvidersApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			if (await secretProvidersUnavailable(user.userId, env)) {
				return jsonResponse({ ok: false, error: 'Not found.' }, 404)
			}
			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountSecretProvidersData({
						env,
						userId: user.mcpUser.userId,
						email: user.email,
						url: request.url,
					}),
				)
			}
			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}
			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}
			const action = readTrimmedStringOrEmpty(body, 'action')
			try {
				if (action === 'bind') {
					return await handleBind({ env, user, body, requestUrl: request.url })
				}
				if (action === 'unbind') {
					return await handleUnbind({ env, user, body })
				}
				if (action === 'grant') {
					return await handleGrant({ env, user, body })
				}
				if (action === 'revoke') {
					return await handleRevoke({ env, user, body })
				}
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to update secret providers.',
					},
					400,
				)
			}
			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<
		| typeof routes.accountSecretProvidersApi
		| typeof routes.accountSecretProvidersApiPost
	>
}

async function handleBind(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	requestUrl: string
}) {
	const bound = await bindSecretProvider({
		env: input.env,
		baseUrl: new URL(input.requestUrl).origin,
		userId: input.user.mcpUser.userId,
		providerId: readTrimmedStringOrEmpty(input.body, 'provider'),
		packageId: readTrimmedStringOrEmpty(input.body, 'packageId'),
		doorSecretName: readTrimmedStringOrEmpty(input.body, 'doorSecretName'),
		config: readConfig(input.body),
	})
	return jsonResponse({ ok: true, bound })
}

async function handleUnbind(input: {
	env: Env
	user: AuthenticatedUser
	body: object
}) {
	await unbindSecretProvider({
		env: input.env,
		userId: input.user.mcpUser.userId,
		providerId: readTrimmedStringOrEmpty(input.body, 'provider'),
	})
	return jsonResponse({ ok: true })
}

async function handleGrant(input: {
	env: Env
	user: AuthenticatedUser
	body: object
}) {
	const granted = await grantSecretProviderToPackage({
		env: input.env,
		userId: input.user.mcpUser.userId,
		providerId: readTrimmedStringOrEmpty(input.body, 'provider'),
		ref: readTrimmedStringOrEmpty(input.body, 'ref'),
		packageId: readTrimmedStringOrEmpty(input.body, 'packageId'),
	})
	return jsonResponse({ ok: true, granted })
}

async function handleRevoke(input: {
	env: Env
	user: AuthenticatedUser
	body: object
}) {
	await revokeSecretProviderGrant({
		env: input.env,
		userId: input.user.mcpUser.userId,
		providerId: readTrimmedStringOrEmpty(input.body, 'provider'),
		ref: readTrimmedStringOrEmpty(input.body, 'ref'),
		packageId: readTrimmedStringOrEmpty(input.body, 'packageId'),
	})
	return jsonResponse({ ok: true })
}

function readConfig(body: object) {
	const value = (body as Record<string, unknown>).config
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	const config: Record<string, string> = {}
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === 'string') config[key] = entry
	}
	return config
}
