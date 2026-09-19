import { waitUntil } from 'cloudflare:workers'
import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountWaitingData } from '#app/account-waiting-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import { sanitizeWaitingCardId } from '#universal/onboarding-funnel.ts'
import { recordOnboardingFunnelEvent } from '#worker/identity/onboarding-funnel.ts'

export function createAccountWaitingHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountWaiting = await loadAccountWaitingData({
				env,
				user,
				waitUntil,
			})
			return renderAppPage({
				request,
				env,
				title: 'Waiting',
				loaderData: { accountWaiting },
			})
		},
	} satisfies Action<typeof routes.accountWaiting>
}

export function createAccountWaitingApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const accountWaiting = await loadAccountWaitingData({
				env,
				user,
				waitUntil,
			})
			return jsonResponse(accountWaiting)
		},
	} satisfies Action<typeof routes.accountWaitingApi>
}

export function createAccountWaitingClickHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}
			const body = (await request.json().catch(() => null)) as {
				cardId?: unknown
			} | null
			const cardId =
				typeof body?.cardId === 'string'
					? sanitizeWaitingCardId(body.cardId)
					: null
			if (!cardId) {
				return jsonResponse({ ok: false, error: 'Unknown card.' }, 400)
			}
			recordOnboardingFunnelEvent(env, {
				stage: 'waiting_card_clicked',
				userId: user.mcpUser.userId,
				dimension: cardId,
			})
			return jsonResponse({ ok: true })
		},
	} satisfies Action<typeof routes.accountWaitingClickPost>
}
