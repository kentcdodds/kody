import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { object, parseSafe, string } from 'remix/data-schema'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	getEnabledOauthProviders,
	isOauthProviderId,
	oauthProviderDefinitions,
} from '#app/oauth-providers.ts'
import { listPasskeysForUser } from '#app/passkeys.ts'
import { type routes } from '#app/routes.ts'

const disconnectSchema = object({
	intent: string(),
	provider: string(),
})

type ConnectionRow = {
	id: number
	provider_name: string
	provider_display_name: string | null
	created_at: string
}

async function listConnections(db: D1Database, userId: number) {
	const result = await db
		.prepare(
			`SELECT id, provider_name, provider_display_name, created_at
			 FROM oauth_connections
			 WHERE user_id = ?
			 ORDER BY created_at, id`,
		)
		.bind(userId)
		.all<ConnectionRow>()
	return result.results ?? []
}

async function hasUsablePassword(db: D1Database, userId: number) {
	const row = await db
		.prepare(`SELECT password_hash FROM users WHERE id = ?`)
		.bind(userId)
		.first<{ password_hash: string }>()
	// Sentinel hashes (admin-created / OAuth-created accounts) never verify,
	// so only a real PBKDF2 hash counts as a usable password.
	return row?.password_hash.startsWith('pbkdf2_sha256$') === true
}

async function loadConnectionsPayload(input: { env: Env; userId: number }) {
	const { env, userId } = input
	const [connections, usablePassword, passkeys] = await Promise.all([
		listConnections(env.APP_DB, userId),
		hasUsablePassword(env.APP_DB, userId),
		listPasskeysForUser(env.APP_DB, userId),
	])
	// Disconnecting the last connection is only safe when another first
	// factor (password or passkey) can still sign the account in.
	const canDisconnect =
		usablePassword || passkeys.length > 0 || connections.length > 1
	const connectedProviders = new Set(
		connections.map((connection) => connection.provider_name),
	)
	return {
		ok: true,
		connections: connections.map((connection) => ({
			provider: connection.provider_name,
			label: isOauthProviderId(connection.provider_name)
				? oauthProviderDefinitions[connection.provider_name].label
				: connection.provider_name,
			displayName: connection.provider_display_name,
			createdAt: connection.created_at,
		})),
		canDisconnect,
		availableProviders: getEnabledOauthProviders(env)
			.filter((provider) => !connectedProviders.has(provider))
			.map((provider) => ({
				id: provider,
				label: oauthProviderDefinitions[provider].label,
			})),
	}
}

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
					await loadConnectionsPayload({ env, userId: user.userId }),
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
				await loadConnectionsPayload({ env, userId: user.userId }),
			)
		},
	} satisfies Action<typeof routes.accountConnectionsApi>
}
