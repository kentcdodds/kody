import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountEmailData } from '#app/account-email-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type AccountEmailLoaderData } from '#universal/loader-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { setEmailMessageClassification } from '#worker/email/service.ts'
import {
	emailClassificationValues,
	type EmailClassification,
} from '#worker/email/types.ts'

function readPathMessageId(params: unknown) {
	if (
		typeof params === 'object' &&
		params !== null &&
		'messageId' in params &&
		typeof params.messageId === 'string'
	) {
		return params.messageId
	}
	return undefined
}

function parseClassification(value: string): EmailClassification | null {
	return (emailClassificationValues as ReadonlyArray<string>).includes(value)
		? (value as EmailClassification)
		: null
}

export function createAccountEmailHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountEmail = await loadAccountEmailData({
				env,
				request,
				user,
				pathMessageId: readPathMessageId(params),
			})
			return renderAppPage({
				request,
				env,
				title: 'Email inbox',
				loaderData: {
					accountEmail: accountEmail as AccountEmailLoaderData,
				},
			})
		},
	} satisfies Action<
		typeof routes.accountEmail | typeof routes.accountEmailDetail
	>
}

/**
 * JSON API for `/account/email.json` (GET + POST). Actions: `classify`.
 */
export function createAccountEmailApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(await loadAccountEmailData({ env, request, user }))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const action = readTrimmedStringOrEmpty(body, 'action')
			if (action !== 'classify') {
				return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
			}

			const messageId = readTrimmedStringOrEmpty(body, 'message_id')
			if (!messageId) {
				return jsonResponse(
					{ ok: false, error: 'Message id is required.' },
					400,
				)
			}

			const classification = parseClassification(
				readTrimmedStringOrEmpty(body, 'classification'),
			)
			if (!classification) {
				return jsonResponse(
					{
						ok: false,
						error: 'Classification must be accepted or quarantined.',
					},
					400,
				)
			}

			const updated = await setEmailMessageClassification({
				env,
				db: env.APP_DB,
				userId: user.mcpUser.userId,
				messageId,
				classification,
				classificationReason:
					classification === 'quarantined' ? 'Reclassified by user.' : null,
			})
			if (!updated) {
				return jsonResponse(
					{
						ok: false,
						error: 'Message not found or is not an inbound message.',
					},
					404,
				)
			}

			const listUrl = new URL(request.url, 'http://localhost')
			listUrl.searchParams.set('selected', messageId)
			return jsonResponse(
				await loadAccountEmailData({
					env,
					request: new Request(listUrl.toString(), { method: 'GET' }),
					user,
				}),
			)
		},
	} satisfies Action<typeof routes.accountEmailApi>
}
