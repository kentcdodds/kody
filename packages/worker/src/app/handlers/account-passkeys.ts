import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { enum_, object, optional, parseSafe, string } from 'remix/data-schema'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	buildDefaultPasskeyName,
	validatePasskeyName,
} from '#app/passkey-label.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import {
	deletePasskeyForUser,
	listPasskeysForUser,
	renamePasskeyForUser,
	type PasskeyRow,
} from '#app/passkeys.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createAccountPasskeysHandler(env: Env) {
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
				title: 'Passkeys',
			})
		},
	} satisfies Action<typeof routes.accountPasskeys>
}

const passkeyActionSchema = object({
	intent: enum_(['delete', 'rename'] as const),
	passkeyId: string(),
	name: optional(string()),
})

export function createAccountPasskeysApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(await loadPasskeysPayload(env.APP_DB, user.userId))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const parsed = parseSafe(passkeyActionSchema, body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const requestIp = getRequestIp(request) ?? undefined
			const intent = parsed.value.intent

			switch (intent) {
				case 'delete': {
					const deleted = await deletePasskeyForUser(
						env.APP_DB,
						parsed.value.passkeyId,
						user.userId,
					)
					if (!deleted) {
						return jsonResponse({ ok: false, error: 'Passkey not found.' }, 404)
					}

					void logAuditEvent({
						category: 'account',
						action: 'passkey_delete',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
					})
					return jsonResponse(
						await loadPasskeysPayload(env.APP_DB, user.userId),
					)
				}
				case 'rename': {
					const validated = validatePasskeyName(parsed.value.name)
					if (!validated.ok) {
						return jsonResponse({ ok: false, error: validated.error }, 400)
					}

					const renamed = await renamePasskeyForUser(
						env.APP_DB,
						parsed.value.passkeyId,
						user.userId,
						validated.name,
					)
					if (!renamed) {
						return jsonResponse({ ok: false, error: 'Passkey not found.' }, 404)
					}

					void logAuditEvent({
						category: 'account',
						action: 'passkey_rename',
						result: 'success',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
					})
					return jsonResponse(
						await loadPasskeysPayload(env.APP_DB, user.userId),
					)
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
	} satisfies Action<typeof routes.accountPasskeysApi>
}

function displayPasskeyName(passkey: PasskeyRow) {
	const stored = passkey.name.trim()
	if (stored) return stored
	return buildDefaultPasskeyName({
		aaguid: passkey.aaguid,
		deviceType: passkey.device_type,
	})
}

async function loadPasskeysPayload(db: D1Database, userId: number) {
	const passkeys = await listPasskeysForUser(db, userId)
	return {
		ok: true,
		passkeys: passkeys.map((passkey) => ({
			id: passkey.id,
			name: displayPasskeyName(passkey),
			deviceType: passkey.device_type,
			backedUp: passkey.backed_up === 1,
			createdAt: passkey.created_at,
			lastUsedAt: passkey.last_used_at,
		})),
	}
}
