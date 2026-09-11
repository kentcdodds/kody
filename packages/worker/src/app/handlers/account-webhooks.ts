import { type Action } from 'remix/router'
import { enum_, object, parseSafe, string } from 'remix/data-schema'
import {
	accountWebhookItemId,
	loadAccountWebhooksData,
	type AccountWebhooksUser,
} from '#app/account-webhooks-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { isMcpCallerError, McpCallerError } from '#mcp/caller-error.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	isWebhookUrlMinted,
	mintWebhookUrlForUser,
	revealWebhookUrlForWebsite,
	rotateWebhookUrlForUser,
	setWebhookEnabledForUser,
} from '#worker/webhooks/service.ts'
import {
	type AccountWebhookRevealedUrl,
	type AccountWebhooksActionPayload,
} from '#universal/loader-data.ts'
import { type routes } from '#universal/routes.ts'

const webhookActionIntents = [
	'mint',
	'rotate',
	'reveal',
	'enable',
	'disable',
] as const

type WebhookActionIntent = (typeof webhookActionIntents)[number]

const webhookActionSchema = object({
	intent: enum_(webhookActionIntents),
	packageKodyId: string(),
	webhookName: string(),
})

type AuthenticatedUser = AccountWebhooksUser &
	Pick<
		NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>,
		'email'
	>

/**
 * Page handler for `/account/webhooks` and
 * `/account/webhooks/:packageKodyId/:webhookName`.
 */
export function createAccountWebhooksHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			const accountWebhooks = await loadAccountWebhooksData({
				env,
				requestUrl: request.url,
				user,
			})
			return renderAppPage({
				request,
				env,
				title: 'Webhooks',
				loaderData: { accountWebhooks },
			})
		},
	} satisfies Action<
		typeof routes.accountWebhooks | typeof routes.accountWebhookDetail
	>
}

/**
 * JSON API for `/account/webhooks.json`: GET lists declared webhooks with
 * minted state; POST mints, rotates, reveals, enables, or disables one.
 *
 * `reveal` (and the reveal that rides along with mint / rotate) is the only
 * place the credential URL leaves the server. It is owner-session gated and
 * audited; the MCP `webhooks` capabilities never return it.
 */
export function createAccountWebhooksApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountWebhooksData({
						env,
						requestUrl: request.url,
						user,
					}),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const parsed = parseSafe(webhookActionSchema, body)
			if (!parsed.success) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}
			const packageKodyId = parsed.value.packageKodyId.trim()
			const webhookName = parsed.value.webhookName.trim()
			if (!packageKodyId || !webhookName) {
				return jsonResponse(
					{ ok: false, error: 'packageKodyId and webhookName are required.' },
					400,
				)
			}

			const intent = parsed.value.intent
			const audit = (result: 'success' | 'failure', reason?: string) => {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: auditActionFor(intent),
					result,
					email: user.email,
					ip: getRequestIp(request) ?? undefined,
					path: url.pathname,
					reason: [
						`package=${packageKodyId}`,
						`webhook=${webhookName}`,
						...(reason ? [reason] : []),
					].join(' '),
				})
			}

			try {
				const revealed = await runWebhookAction({
					env,
					request,
					user,
					intent,
					packageKodyId,
					webhookName,
				})
				audit('success')
				const payload: AccountWebhooksActionPayload = {
					...(await loadAccountWebhooksData({
						env,
						requestUrl: request.url,
						user,
					})),
					...(revealed ? { revealed } : {}),
				}
				return jsonResponse(payload)
			} catch (error) {
				const detail =
					error instanceof Error ? error.message : failureMessageFor(intent)
				audit('failure', detail)
				// Caller mistakes (unknown package, undeclared webhook, not minted,
				// legacy secret) carry safe messages. Anything else is an
				// infrastructure failure whose text must not reach the browser.
				if (isMcpCallerError(error)) {
					return jsonResponse({ ok: false, error: detail }, 400)
				}
				console.error('account webhooks action failed', {
					intent,
					packageKodyId,
					webhookName,
					error,
				})
				return jsonResponse(
					{ ok: false, error: failureMessageFor(intent) },
					500,
				)
			}
		},
	} satisfies Action<typeof routes.accountWebhooksApi>
}

async function runWebhookAction(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	intent: WebhookActionIntent
	packageKodyId: string
	webhookName: string
}): Promise<AccountWebhookRevealedUrl | null> {
	const { env, request, user, intent, packageKodyId, webhookName } = input
	const shared = {
		env,
		userId: user.mcpUser.userId,
		email: user.email,
		username: user.username,
		kodyId: packageKodyId,
		webhookName,
		requestUrl: request.url,
	}
	switch (intent) {
		case 'mint': {
			// Mint on an existing row would silently rotate (and re-enable) the
			// credential; make the owner choose Rotate for that.
			if (await isWebhookUrlMinted(shared)) {
				throw new McpCallerError(
					'This webhook already has a URL. Rotate it to issue a new one.',
				)
			}
			await mintWebhookUrlForUser(shared)
			return revealForUi({ ...shared, packageKodyId })
		}
		case 'rotate': {
			await rotateWebhookUrlForUser(shared)
			return revealForUi({ ...shared, packageKodyId })
		}
		case 'reveal': {
			return revealForUi({ ...shared, packageKodyId })
		}
		case 'enable': {
			await setWebhookEnabledForUser({ ...shared, enabled: true })
			return null
		}
		case 'disable': {
			await setWebhookEnabledForUser({ ...shared, enabled: false })
			return null
		}
		default: {
			const exhaustive: never = intent
			throw new Error(`Unhandled webhook intent: ${String(exhaustive)}`)
		}
	}
}

async function revealForUi(input: {
	env: Env
	userId: string
	email: string
	username: string
	packageKodyId: string
	webhookName: string
	requestUrl: string
}): Promise<AccountWebhookRevealedUrl> {
	const revealed = await revealWebhookUrlForWebsite({
		env: input.env,
		userId: input.userId,
		email: input.email,
		username: input.username,
		requestUrl: input.requestUrl,
		target: { kodyId: input.packageKodyId, webhookName: input.webhookName },
	})
	return {
		id: accountWebhookItemId({
			packageKodyId: input.packageKodyId,
			name: input.webhookName,
		}),
		handle: revealed.handle,
		url: revealed.url,
	}
}

function auditActionFor(intent: WebhookActionIntent) {
	switch (intent) {
		case 'mint':
			return 'webhook_url_mint'
		case 'rotate':
			return 'webhook_url_rotate'
		case 'reveal':
			return 'webhook_url_reveal'
		case 'enable':
			return 'webhook_enable'
		case 'disable':
			return 'webhook_disable'
		default: {
			const exhaustive: never = intent
			return String(exhaustive)
		}
	}
}

function failureMessageFor(intent: WebhookActionIntent) {
	switch (intent) {
		case 'mint':
			return 'Unable to mint the webhook URL.'
		case 'rotate':
			return 'Unable to rotate the webhook URL.'
		case 'reveal':
			return 'Unable to reveal the webhook URL.'
		case 'enable':
			return 'Unable to enable the webhook.'
		case 'disable':
			return 'Unable to disable the webhook.'
		default: {
			const exhaustive: never = intent
			return String(exhaustive)
		}
	}
}
