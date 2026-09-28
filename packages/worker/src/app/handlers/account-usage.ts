import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountUsageData } from '#app/account-usage-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { accountCreditsPath } from '#universal/compute-overage.ts'
import { type routes } from '#universal/routes.ts'
import {
	applyCreditTopUpFromCheckoutSession,
	CreditTopUpError,
} from '#worker/billing/credit-top-ups.ts'

const creditsNoticeMessages: Record<string, string> = {
	added:
		'Credits added. Usage past your monthly include runs on them within a minute.',
}

const creditsErrorMessages: Record<string, string> = {
	topup_failed: 'We could not confirm that top-up. Refresh in a moment.',
	not_paid: 'That top-up has not been paid yet.',
	client_reference_mismatch: 'That top-up does not belong to your account.',
}

function readMessage(
	messages: Record<string, string>,
	code: string | null,
): string | undefined {
	return code && Object.hasOwn(messages, code) ? messages[code] : undefined
}

function creditsRedirect(request: Request, params: Record<string, string>) {
	const url = new URL(accountCreditsPath, request.url)
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}
	return Response.redirect(url.toString(), 302)
}

export function createAccountUsageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const searchParams = new URL(request.url).searchParams
			const sessionId = searchParams.get('session_id')?.trim()
			if (searchParams.get('topup') === 'success' && sessionId) {
				try {
					await applyCreditTopUpFromCheckoutSession({
						env,
						sessionId,
						expectedStableUserId: user.mcpUser.userId,
						now: new Date(),
					})
					return creditsRedirect(request, { credits: 'added' })
				} catch (error) {
					const code =
						error instanceof CreditTopUpError ? error.code : 'topup_failed'
					console.error('credit_top_up_confirm_failed', { code })
					return creditsRedirect(request, {
						error: readMessage(creditsErrorMessages, code)
							? code
							: 'topup_failed',
					})
				}
			}

			const accountUsage = await loadAccountUsageData({
				env,
				userId: user.userId,
				notice: readMessage(creditsNoticeMessages, searchParams.get('credits')),
				error: readMessage(creditsErrorMessages, searchParams.get('error')),
			})
			if (!accountUsage) {
				return new Response('Not found', { status: 404 })
			}
			return renderAppPage({
				request,
				env,
				title: 'Usage',
				loaderData: { accountUsage },
			})
		},
	} satisfies Action<typeof routes.accountUsage>
}

export function createAccountUsageApiHandler(env: Env) {
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

			const accountUsage = await loadAccountUsageData({
				env,
				userId: user.userId,
			})
			if (!accountUsage) {
				return jsonResponse({ ok: false, error: 'Not found.' }, 404)
			}
			return jsonResponse(accountUsage)
		},
	} satisfies Action<typeof routes.accountUsageApi>
}
