import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { enum_, object, optional, parseSafe, string } from 'remix/data-schema'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import {
	getOAuthClientHelpers,
	listUserMcpOauthClients,
	mintUserMcpOauthClient,
	parseClientLabel,
	parseRedirectUriText,
	revokeUserMcpOauthClient,
	type UserMcpOauthClientListItem,
} from '#app/account-mcp-oauth-clients.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type AccountMcpOauthClientsLoaderData } from '#universal/loader-data.ts'
import { type routes } from '#universal/routes.ts'

export function createAccountMcpOauthClientsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			return renderAppPage({
				request,
				env,
				title: 'MCP OAuth clients',
				loaderData: {
					accountMcpOauthClients: await loadClientsPayload(
						env.APP_DB,
						user.userId,
					),
				},
			})
		},
	} satisfies Action<typeof routes.accountMcpOauthClients>
}

const clientActionSchema = object({
	intent: enum_(['create', 'revoke'] as const),
	id: optional(string()),
	label: optional(string()),
	redirectUris: optional(string()),
})

export function createAccountMcpOauthClientsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(await loadClientsPayload(env.APP_DB, user.userId))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const parsed = parseSafe(clientActionSchema, body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const requestIp = getRequestIp(request) ?? undefined
			const intent = parsed.value.intent

			switch (intent) {
				case 'create': {
					if (!user.emailVerified) {
						return jsonResponse(
							{
								ok: false,
								error: 'Verify your email before creating an MCP OAuth client.',
							},
							403,
						)
					}

					const label = parseClientLabel(parsed.value.label)
					if (!label.ok) {
						return jsonResponse({ ok: false, error: label.error }, 400)
					}
					const redirectUris = parseRedirectUriText(parsed.value.redirectUris)
					if (!redirectUris.ok) {
						return jsonResponse({ ok: false, error: redirectUris.error }, 400)
					}

					let helpers: ReturnType<typeof getOAuthClientHelpers>
					try {
						helpers = getOAuthClientHelpers(env)
					} catch {
						return jsonResponse(
							{ ok: false, error: 'OAuth client registration is unavailable.' },
							503,
						)
					}

					const minted = await mintUserMcpOauthClient({
						db: env.APP_DB,
						helpers,
						userId: user.userId,
						label: label.label,
						redirectUris: redirectUris.uris,
					})
					if (!minted.ok) {
						return jsonResponse(
							{ ok: false, error: minted.error },
							minted.status,
						)
					}

					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'oauth',
						action: 'mcp_oauth_client_create',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						clientId: minted.client.clientId,
					})
					return jsonResponse({
						...(await loadClientsPayload(env.APP_DB, user.userId)),
						createdClient: minted.client,
					})
				}
				case 'revoke': {
					const id = parsed.value.id?.trim() ?? ''
					if (!id) {
						return jsonResponse(
							{ ok: false, error: 'OAuth client id is required.' },
							400,
						)
					}

					let helpers: ReturnType<typeof getOAuthClientHelpers>
					try {
						helpers = getOAuthClientHelpers(env)
					} catch {
						return jsonResponse(
							{ ok: false, error: 'OAuth client registration is unavailable.' },
							503,
						)
					}

					const revoked = await revokeUserMcpOauthClient({
						db: env.APP_DB,
						helpers,
						userId: user.userId,
						id,
					})
					if (!revoked.ok) {
						return jsonResponse(
							{ ok: false, error: revoked.error },
							revoked.status,
						)
					}

					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'oauth',
						action: 'mcp_oauth_client_revoke',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
					})
					return jsonResponse(await loadClientsPayload(env.APP_DB, user.userId))
				}
				default: {
					const _exhaustive: never = intent
					void _exhaustive
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}
			}
		},
	} satisfies Action<typeof routes.accountMcpOauthClientsApi>
}

async function loadClientsPayload(
	db: D1Database,
	userId: number,
): Promise<AccountMcpOauthClientsLoaderData> {
	const clients: Array<UserMcpOauthClientListItem> =
		await listUserMcpOauthClients(db, userId)
	return {
		ok: true,
		clients,
	}
}
