import { type BuildAction } from 'remix/fetch-router'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'
import {
	disableEmailSenderPolicy,
	getEmailMessageById,
	listEmailAgentRunsForThread,
	listEmailAttachmentsForMessage,
	listEmailInboxAddressesForUser,
	listEmailInboxesForUser,
	listEmailMessages,
	listEmailSenderPolicies,
	upsertEmailSenderPolicy,
} from '#worker/email/repo.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import {
	type EmailAgentRunRecord,
	type EmailMessageRecord,
} from '#worker/email/types.ts'

type AccountEmailPolicyView = {
	id: string
	inbox_id: string | null
	kind: string
	value: string
	effect: string
	enabled: boolean
	created_at: string
	updated_at: string
}

type AccountEmailInboxView = {
	id: string
	name: string
	description: string
	mode: string
	enabled: boolean
	addresses: Array<{
		id: string
		address: string
		enabled: boolean
	}>
	policies: Array<AccountEmailPolicyView>
}

type AccountEmailRunView = {
	id: string
	status: string
	tool_calls_used: number
	tool_call_limit: number
	trace_url: string | null
	summary: string | null
	stop_reason: string | null
	finish_reason: string | null
	error: string | null
	reply_message_id: string | null
	started_at: string
	completed_at: string | null
}

type AccountEmailMessageView = {
	id: string
	direction: string
	inbox_id: string | null
	thread_id: string | null
	from_address: string | null
	subject: string | null
	policy_decision: string
	processing_status: string
	text_body: string | null
	html_body: string | null
	received_at: string | null
	sent_at: string | null
	attachments: Array<{
		id: string
		filename: string | null
		content_type: string | null
		size: number
	}>
	agent_runs: Array<AccountEmailRunView>
}

type AccountEmailPayload = {
	ok: true
	email: string
	inboxes: Array<AccountEmailInboxView>
	selected_message: AccountEmailMessageView | null
	messages: Array<{
		id: string
		inbox_id: string | null
		thread_id: string | null
		from_address: string | null
		subject: string | null
		policy_decision: string
		processing_status: string
		received_at: string | null
		created_at: string
	}>
}

export function createAccountEmailHandler(_env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			const { session, setCookie } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}
			const response = render(Layout({ title: 'Email settings' }))
			if (setCookie) {
				response.headers.set('Set-Cookie', setCookie)
			}
			return response
		},
	} satisfies BuildAction<
		typeof routes.accountEmail.method,
		typeof routes.accountEmail.pattern
	>
}

export function createAccountEmailApiHandler(env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await buildAccountEmailPayload({
						request,
						env,
						userId: user.mcpUser.userId,
						email: user.email,
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

			const action = readString(body, 'action')
			if (action === 'approve_sender' || action === 'approve_domain') {
				const inboxId = readOptionalString(body, 'inboxId')
				const rawValue =
					action === 'approve_sender'
						? normalizeEmailAddress(readString(body, 'value') ?? '')
						: (readString(body, 'value')?.trim().toLowerCase() ?? null)
				if (!rawValue) {
					return jsonResponse(
						{ ok: false, error: 'A valid value is required.' },
						400,
					)
				}
				await upsertEmailSenderPolicy({
					db: env.APP_DB,
					userId: user.mcpUser.userId,
					inboxId,
					kind: action === 'approve_sender' ? 'sender' : 'domain',
					value: rawValue,
					effect: 'allow',
				})
				return jsonResponse(
					await buildAccountEmailPayload({
						request,
						env,
						userId: user.mcpUser.userId,
						email: user.email,
					}),
				)
			}

			if (action === 'revoke_policy') {
				const kind = readString(body, 'kind')
				const value = readString(body, 'value')
				const inboxId = readOptionalString(body, 'inboxId')
				if (
					(kind !== 'sender' && kind !== 'domain' && kind !== 'reply_token') ||
					!value
				) {
					return jsonResponse(
						{ ok: false, error: 'Policy kind and value are required.' },
						400,
					)
				}
				await disableEmailSenderPolicy({
					db: env.APP_DB,
					userId: user.mcpUser.userId,
					kind,
					value,
					inboxId,
				})
				return jsonResponse(
					await buildAccountEmailPayload({
						request,
						env,
						userId: user.mcpUser.userId,
						email: user.email,
					}),
				)
			}

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies BuildAction<
		typeof routes.accountEmailApi.method,
		typeof routes.accountEmailApi.pattern
	>
}

async function buildAccountEmailPayload(input: {
	request: Request
	env: Env
	userId: string
	email: string
}): Promise<AccountEmailPayload> {
	const url = new URL(input.request.url)
	const selectedMessageId = url.searchParams.get('selected')?.trim() ?? null
	const [inboxes, addresses, policies, messages, selectedMessage] =
		await Promise.all([
			listEmailInboxesForUser({
				db: input.env.APP_DB,
				userId: input.userId,
			}),
			listEmailInboxAddressesForUser({
				db: input.env.APP_DB,
				userId: input.userId,
			}),
			listEmailSenderPolicies({
				db: input.env.APP_DB,
				userId: input.userId,
				includeDisabled: true,
			}),
			listEmailMessages({
				db: input.env.APP_DB,
				userId: input.userId,
				limit: 50,
			}),
			selectedMessageId
				? getEmailMessageById({
						db: input.env.APP_DB,
						userId: input.userId,
						messageId: selectedMessageId,
					})
				: Promise.resolve(null),
		])

	const selectedMessageView = selectedMessage
		? await buildSelectedMessageView({
				env: input.env,
				message: selectedMessage,
				userId: input.userId,
			})
		: null

	return {
		ok: true,
		email: input.email,
		inboxes: inboxes.map((inbox) => ({
			id: inbox.id,
			name: inbox.name,
			description: inbox.description,
			mode: inbox.mode,
			enabled: inbox.enabled,
			addresses: addresses
				.filter((address) => address.inboxId === inbox.id)
				.map((address) => ({
					id: address.id,
					address: address.address,
					enabled: address.enabled,
				})),
			policies: policies
				.filter(
					(policy) => policy.inboxId === null || policy.inboxId === inbox.id,
				)
				.map((policy) => ({
					id: policy.id,
					inbox_id: policy.inboxId,
					kind: policy.kind,
					value: policy.value,
					effect: policy.effect,
					enabled: policy.enabled,
					created_at: policy.createdAt,
					updated_at: policy.updatedAt,
				})),
		})),
		selected_message: selectedMessageView,
		messages: messages.map((message) => ({
			id: message.id,
			inbox_id: message.inboxId,
			thread_id: message.threadId,
			from_address: message.fromAddress,
			subject: message.subject,
			policy_decision: message.policyDecision,
			processing_status: message.processingStatus,
			received_at: message.receivedAt,
			created_at: message.createdAt,
		})),
	}
}

async function buildSelectedMessageView(input: {
	env: Env
	userId: string
	message: EmailMessageRecord
}) {
	const attachments = await listEmailAttachmentsForMessage({
		db: input.env.APP_DB,
		messageId: input.message.id,
	})
	const runs = input.message.threadId
		? await listEmailAgentRunsForThread({
				db: input.env.APP_DB,
				threadId: input.message.threadId,
			})
		: []
	return {
		id: input.message.id,
		direction: input.message.direction,
		inbox_id: input.message.inboxId,
		thread_id: input.message.threadId,
		from_address: input.message.fromAddress,
		subject: input.message.subject,
		policy_decision: input.message.policyDecision,
		processing_status: input.message.processingStatus,
		text_body: input.message.textBody,
		html_body: input.message.htmlBody,
		received_at: input.message.receivedAt,
		sent_at: input.message.sentAt,
		attachments: attachments.map((attachment) => ({
			id: attachment.id,
			filename: attachment.filename,
			content_type: attachment.contentType,
			size: attachment.size,
		})),
		agent_runs: runs
			.filter(
				(run: EmailAgentRunRecord) => run.inboundMessageId === input.message.id,
			)
			.map((run: EmailAgentRunRecord) => ({
				id: run.id,
				status: run.status,
				tool_calls_used: run.toolCallsUsed,
				tool_call_limit: run.toolCallLimit,
				trace_url: run.traceUrl,
				summary: run.summary,
				stop_reason: run.stopReason,
				finish_reason: run.finishReason,
				error: run.error,
				reply_message_id: run.replyMessageId,
				started_at: run.startedAt,
				completed_at: run.completedAt,
			})),
	}
}

function readString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
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
