import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAdminReservedUsernamesData } from '#app/admin-reserved-usernames-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	addReservedUsernames,
	InvalidReservedUsernameError,
	PermanentlyReservedUsernameError,
	removeReservedUsernames,
} from '#worker/identity/reserved-username-settings.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { readNonEmptyTrimmedStringOrNumber } from '#app/request-body.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createAdminReservedUsernamesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}

			const adminReservedUsernames = await loadAdminReservedUsernamesData(env)

			return renderAppPage({
				request,
				env,
				title: 'Admin reserved usernames',
				loaderData: { adminReservedUsernames },
			})
		},
	} satisfies Action<typeof routes.adminReservedUsernames>
}

export function createAdminReservedUsernamesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithRole(request, env, 'admin')
					const payload = await loadAdminReservedUsernamesData(env)
					return jsonResponse(payload)
				}

				if (request.method !== 'POST') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}

				const actor = await requireUserWithRole(request, env, 'admin')
				const body = await request.json().catch(() => null)
				if (!body || typeof body !== 'object') {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}

				const action = readNonEmptyTrimmedStringOrNumber(body, 'action')
				if (action === 'add') {
					return handleMutationAction({
						env,
						request,
						url,
						actor,
						body,
						kind: 'add',
					})
				}
				if (action === 'remove') {
					return handleMutationAction({
						env,
						request,
						url,
						actor,
						body,
						kind: 'remove',
					})
				}

				return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminReservedUsernamesApi>
}

function readUsernames(body: object) {
	const record = body as Record<string, unknown>
	if (Array.isArray(record.usernames)) {
		return record.usernames.filter(
			(value): value is string => typeof value === 'string',
		)
	}
	const text =
		readNonEmptyTrimmedStringOrNumber(body, 'usernames') ??
		readNonEmptyTrimmedStringOrNumber(body, 'text')
	return text ? [text] : []
}

async function handleMutationAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
	kind: 'add' | 'remove'
}) {
	const usernames = readUsernames(input.body)
	try {
		if (input.kind === 'add') {
			await addReservedUsernames({
				env: input.env,
				usernames,
				updatedBy: input.actor.mcpUser.userId,
			})
		} else {
			await removeReservedUsernames({
				env: input.env,
				usernames,
				updatedBy: input.actor.mcpUser.userId,
			})
		}
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Unable to update reserved usernames.'
		const status =
			error instanceof PermanentlyReservedUsernameError ||
			error instanceof InvalidReservedUsernameError ||
			(error instanceof Error &&
				error.message === 'Provide at least one username.')
				? 400
				: 500
		return jsonResponse({ ok: false, error: message }, status)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action:
			input.kind === 'add'
				? 'reserved_username_add'
				: 'reserved_username_remove',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `usernames=${usernames.join(',')}`,
	})

	return jsonResponse(await loadAdminReservedUsernamesData(input.env))
}
