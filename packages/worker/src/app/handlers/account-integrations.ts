import { z } from 'zod'
import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import {
	loadAccountIntegrationByName,
	loadAccountIntegrationsData,
	loadAccountOauthAppBySlug,
} from '#app/account-integrations-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { toOauthAppPublic } from '#mcp/capabilities/integrations/oauth-app-shared.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import {
	listSecrets,
	saveSecret,
	setSecretAllowedHosts,
} from '#mcp/secrets/service.ts'
import {
	getOauthApp,
	listJoinedIntegrations,
	rotateOauthAppClientCredentials,
} from '#worker/integrations/service.ts'
import { type routes } from '#app/routes.ts'

const rotateOauthAppCredentialsSchema = z
	.object({
		action: z.literal('rotate_oauth_app_credentials'),
		appSlug: z.string().min(1),
		clientId: z.string().min(1).optional(),
		clientSecret: z.string().min(1).optional(),
		confirm: z.literal(true),
	})
	.strict()
	.refine((value) => Boolean(value.clientId || value.clientSecret), {
		message: 'Provide a new client id and/or client secret.',
	})

export function createAccountIntegrationsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountIntegrations = await loadAccountIntegrationsData(env, user)
			return renderAppPage({
				request,
				env,
				title: 'Integrations',
				loaderData: { accountIntegrations },
			})
		},
	} satisfies Action<
		| typeof routes.accountIntegrations
		| typeof routes.accountOauthAppDetail
		| typeof routes.accountIntegrationDetail
	>
}

export function createAccountIntegrationsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const searchParams = new URL(request.url).searchParams
				const name = searchParams.get('name')?.trim()
				if (name) {
					return jsonResponse({
						ok: true,
						integration: await loadAccountIntegrationByName(env, user, name),
					})
				}
				const appSlug = searchParams.get('appSlug')?.trim()
				if (appSlug) {
					const app = await loadAccountOauthAppBySlug(env, user, appSlug)
					if (!app) {
						return jsonResponse(
							{ ok: false, error: 'OAuth app not found.' },
							404,
						)
					}
					return jsonResponse({ ok: true, app })
				}
				return jsonResponse(await loadAccountIntegrationsData(env, user))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const parsed = rotateOauthAppCredentialsSchema.safeParse(body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			return handleRotateOauthAppCredentials({
				env,
				user,
				body: parsed.data,
			})
		},
	} satisfies Action<
		| typeof routes.accountIntegrationsApi
		| typeof routes.accountIntegrationsApiPost
	>
}

async function handleRotateOauthAppCredentials(input: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	body: z.infer<typeof rotateOauthAppCredentialsSchema>
}) {
	const userId = input.user.mcpUser.userId
	const existing = await getOauthApp({
		env: input.env,
		userId,
		slug: input.body.appSlug,
	})
	if (!existing) {
		return jsonResponse({ ok: false, error: 'OAuth app not found.' }, 404)
	}

	const nextClientId = input.body.clientId?.trim() || existing.clientId
	let nextClientSecretSecretName = existing.clientSecretSecretName

	try {
		if (input.body.clientSecret) {
			const secretName =
				existing.clientSecretSecretName ??
				`${canonicalIntegrationName(existing.slug) || existing.slug}ClientSecret`
			const storageContext = {
				sessionId: null,
				appId: null,
				packageId: null,
			}
			// Merge endpoint hosts into any pre-existing allowlist so rotation
			// cannot silently drop hosts packages already rely on.
			const currentSecrets = await listSecrets({
				env: input.env,
				userId,
				scope: 'user',
				storageContext,
			})
			const existingSecret = currentSecrets.find(
				(secret) => secret.name === secretName && secret.scope === 'user',
			)
			const allowedHosts = normalizeAllowedHosts([
				...(existingSecret?.allowedHosts ?? []),
				...oauthAppSecretAllowedHosts(existing),
			])
			await saveSecret({
				env: input.env,
				userId,
				userEmail: input.user.mcpUser.email,
				name: secretName,
				value: input.body.clientSecret,
				scope: 'user',
				description: `${existing.provider} OAuth client secret`,
				storageContext,
			})
			await setSecretAllowedHosts({
				env: input.env,
				userId,
				name: secretName,
				scope: 'user',
				allowedHosts,
				storageContext,
			})
			nextClientSecretSecretName = secretName
		}

		const rotated = await rotateOauthAppClientCredentials({
			env: input.env,
			userId,
			slug: existing.slug,
			clientId: nextClientId,
			clientSecretSecretName: nextClientSecretSecretName,
		})
		const joined = await listJoinedIntegrations({
			env: input.env,
			userId,
		})
		const connections = joined
			.filter((entry) => entry.app.slug === rotated.slug)
			.map(({ connection }) => ({
				name: connection.name,
				accountLabel: connection.accountLabel,
			}))
		return jsonResponse({
			ok: true,
			app: toOauthAppPublic(
				{ ...rotated, connectionCount: connections.length },
				connections,
			),
		})
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to rotate OAuth app credentials.',
			},
			400,
		)
	}
}

function oauthAppSecretAllowedHosts(app: {
	tokenUrl: string
	authorizeUrl: string | null
	apiBaseUrl: string | null
}): Array<string> {
	const hosts = [
		safeParseHost(app.tokenUrl),
		app.authorizeUrl ? safeParseHost(app.authorizeUrl) : null,
		app.apiBaseUrl ? safeParseHost(app.apiBaseUrl) : null,
	].filter((host): host is string => Boolean(host))
	return hosts
}
