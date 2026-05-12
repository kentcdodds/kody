import { type BuildAction } from 'remix/fetch-router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getUniqueConstraintField } from '#app/database-errors.ts'
import { type routes } from '#app/routes.ts'
import { getUsernameValidationError, normalizeUsername } from '#app/username.ts'
import { createDb, usersTable } from '#worker/db.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

type AccountProfilePayload = {
	ok: true
	email: string
	username: string
	displayName: string
}

export function createAccountProfileApiHandler(env: Env) {
	const db = createDb(env.APP_DB)

	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(buildPayload(user))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const username = normalizeUsername(
				(body as Record<string, unknown>).username,
			)
			const usernameError = getUsernameValidationError(username)
			if (usernameError) {
				return jsonResponse({ ok: false, error: usernameError }, 400)
			}

			const requestIp = getRequestIp(request) ?? undefined
			const existingUsername = await db.findOne(usersTable, {
				where: { username },
			})
			if (existingUsername && existingUsername.id !== user.userId) {
				void logAuditEvent({
					category: 'account',
					action: 'update_username',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'username_exists',
				})
				return jsonResponse(
					{ ok: false, error: 'Username already registered.' },
					409,
				)
			}

			try {
				await db.update(usersTable, user.userId, {
					username,
					updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
				})
			} catch (error) {
				if (getUniqueConstraintField(error) === 'username') {
					void logAuditEvent({
						category: 'account',
						action: 'update_username',
						result: 'failure',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: 'username_exists',
					})
					return jsonResponse(
						{ ok: false, error: 'Username already registered.' },
						409,
					)
				}
				throw error
			}

			void logAuditEvent({
				category: 'account',
				action: 'update_username',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
			})

			return jsonResponse(
				buildPayload({
					...user,
					username,
					displayName: username,
					mcpUser: { ...user.mcpUser, displayName: username },
				}),
			)
		},
	} satisfies BuildAction<
		typeof routes.accountProfileApi.method,
		typeof routes.accountProfileApi.pattern
	>
}

function buildPayload(user: AuthenticatedUser): AccountProfilePayload {
	return {
		ok: true,
		email: user.email,
		username: user.username,
		displayName: user.displayName,
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
