import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	loadAccountExperimentsData,
	setExperimentsOptIn,
} from '#app/account-experiments-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

function readExperimentsOptInBody(body: object): boolean | null {
	if (!('experimentsOptIn' in body)) return null
	const value = (body as { experimentsOptIn: unknown }).experimentsOptIn
	if (typeof value !== 'boolean') return null
	return value
}

export function createAccountExperimentsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountExperiments = await loadAccountExperimentsData({
				db: env.APP_DB,
				userId: user.userId,
			})
			return renderAppPage({
				request,
				env,
				title: 'Experiments',
				loaderData: { accountExperiments },
			})
		},
	} satisfies Action<typeof routes.accountExperiments>
}

export function createAccountExperimentsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountExperimentsData({
						db: env.APP_DB,
						userId: user.userId,
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

			const experimentsOptIn = readExperimentsOptInBody(body)
			if (experimentsOptIn === null) {
				return jsonResponse(
					{ ok: false, error: 'experimentsOptIn must be a boolean.' },
					400,
				)
			}

			await setExperimentsOptIn(env.APP_DB, {
				userId: user.userId,
				enabled: experimentsOptIn,
			})

			const requestIp = getRequestIp(request) ?? undefined
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'account',
				action: experimentsOptIn ? 'experiments_opt_in' : 'experiments_opt_out',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: `experiments_opt_in=${experimentsOptIn}`,
			})

			return jsonResponse(
				await loadAccountExperimentsData({
					db: env.APP_DB,
					userId: user.userId,
				}),
			)
		},
	} satisfies Action<typeof routes.accountExperimentsApi>
}
