import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { object, parseSafe, string } from 'remix/data-schema'
import { loadAccountConnectionsData } from '#app/account-connections-data.ts'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { isOauthProviderId } from '#app/oauth-providers.ts'
import { type routes } from '#universal/routes.ts'

const disconnectSchema = object({
	intent: string(),
	provider: string(),
})

export function createAccountConnectionsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountConnectionsData({ env, userId: user.userId }),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const parsed = parseSafe(disconnectSchema, body)
			if (
				!parsed.success ||
				parsed.value.intent !== 'disconnect' ||
				!isOauthProviderId(parsed.value.provider)
			) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}
			const provider = parsed.value.provider

			const existing = await env.APP_DB.prepare(
				`SELECT id FROM oauth_connections WHERE user_id = ? AND provider_name = ?`,
			)
				.bind(user.userId, provider)
				.first<{ id: number }>()
			if (!existing) {
				return jsonResponse({ ok: false, error: 'Connection not found.' }, 404)
			}

			// Removing this provider must leave at least one working sign-in
			// method: a usable password, a passkey, or another connection. The
			// guard lives inside the DELETE itself so concurrent disconnects
			// cannot both pass a separate pre-check and remove every method.
			const result = await env.APP_DB.prepare(
				`DELETE FROM oauth_connections
				 WHERE user_id = ?1 AND provider_name = ?2
				 AND (
					EXISTS (
						SELECT 1 FROM users
						WHERE id = ?1 AND password_hash LIKE 'pbkdf2_sha256$%'
					)
					OR EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?1)
					OR EXISTS (
						SELECT 1 FROM oauth_connections
						WHERE user_id = ?1 AND provider_name != ?2
					)
				 )`,
			)
				.bind(user.userId, provider)
				.run()
			if ((result.meta?.changes ?? 0) === 0) {
				return jsonResponse(
					{
						ok: false,
						error:
							'This connection is your only way to sign in. Set a password or register a passkey first.',
					},
					400,
				)
			}

			void logAuditEvent({
				category: 'auth',
				action: 'oauth_connection_removed',
				result: 'success',
				email: user.email,
				ip: getRequestIp(request) ?? undefined,
				path: url.pathname,
				reason: `provider=${provider}`,
			})
			return jsonResponse(
				await loadAccountConnectionsData({ env, userId: user.userId }),
			)
		},
	} satisfies Action<typeof routes.accountConnectionsApi>
}
