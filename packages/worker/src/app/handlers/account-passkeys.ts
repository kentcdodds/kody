import { type Action } from 'remix/router'
import { object, parseSafe, string } from 'remix/data-schema'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import { deletePasskeyForUser, listPasskeysForUser } from '#app/passkeys.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'
import { type AppEnv } from '#worker/env-schema.ts'

export function createAccountPasskeysHandler(env: Env) {
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

			return renderAppPage({
				request,
				env,
				title: 'Passkeys',
			})
		},
	} satisfies Action<typeof routes.accountPasskeys>
}

const deletePasskeySchema = object({
	intent: string(),
	passkeyId: string(),
})

export function createAccountPasskeysApiHandler(appEnv: AppEnv) {
	const env = appEnv as unknown as Env

	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadPasskeysPayload(appEnv.APP_DB, user.userId),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const parsed = parseSafe(deletePasskeySchema, body)
			if (!parsed.success || parsed.value.intent !== 'delete') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const requestIp = getRequestIp(request) ?? undefined
			const deleted = await deletePasskeyForUser(
				appEnv.APP_DB,
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
			return jsonResponse(await loadPasskeysPayload(appEnv.APP_DB, user.userId))
		},
	} satisfies Action<typeof routes.accountPasskeysApi>
}

async function loadPasskeysPayload(db: D1Database, userId: number) {
	const passkeys = await listPasskeysForUser(db, userId)
	return {
		ok: true,
		passkeys: passkeys.map((passkey) => ({
			id: passkey.id,
			deviceType: passkey.device_type,
			backedUp: passkey.backed_up === 1,
			createdAt: passkey.created_at,
		})),
	}
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
