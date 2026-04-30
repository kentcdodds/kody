import { createMcpCallerContext } from '#mcp/context.ts'
import {
	beginAgentTurn,
	collectAgentTurnEvents,
} from '#worker/agent-turn/api.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { buildKodySenderIdentity } from './kody-sender.ts'
import { getEmailDomain } from './address.ts'
import { sendOutboundEmail } from './outbound.ts'
import {
	createEmailAgentRun,
	type getLatestEmailAgentRunForThread,
	insertEmailDeliveryEvent,
	updateEmailAgentRun,
	upsertEmailSenderIdentity,
} from './repo.ts'
import {
	type EmailAgentRunRecord,
	type EmailInboxRecord,
	type EmailMessageRecord,
} from './types.ts'

const emailAgentToolCallLimit = 20
const blockedEmailCapabilityNames = new Set([
	'email_sender_approve',
	'email_sender_revoke',
])

type EmailLoopEnv = Env

type AgentLoopRuntimeEnv = Env & EmailLoopEnv

type EmailLoopResult = {
	run: EmailAgentRunRecord
	replyMessageId: string | null
}

function summarizeText(value: string | null | undefined, maxLength = 500) {
	const normalized = value?.trim() ?? ''
	if (!normalized) return null
	if (normalized.length <= maxLength) return normalized
	return `${normalized.slice(0, maxLength)}...`
}

function buildEmailAgentSessionId(threadId: string) {
	return `email-thread-${threadId}`
}

function buildTraceUrl(input: {
	baseUrl: string
	inboundMessageId: string
	runId: string
}) {
	const url = new URL('/account/email', input.baseUrl)
	url.searchParams.set('selected', input.inboundMessageId)
	url.searchParams.set('run', input.runId)
	return url.toString()
}

function buildAgentSystemPrompt(input: {
	inbox: EmailInboxRecord
	sender: string
}) {
	const inboxName = input.inbox.name.trim() || 'email inbox'
	return [
		'You are Kody handling an approved inbound email.',
		`The request came through the inbox "${inboxName}" from ${input.sender}.`,
		'Use the existing Kody search and execute tools to gather information and act.',
		'Do not change email sender approval policy or inbox configuration.',
		'Respond with a concise useful result for the email sender.',
	].join(' ')
}

function buildAgentUserMessage(message: EmailMessageRecord) {
	const parts = [
		`From: ${message.fromAddress ?? message.envelopeFrom ?? 'unknown'}`,
		`Subject: ${message.subject ?? '(no subject)'}`,
	]
	if (message.textBody?.trim()) {
		parts.push('', message.textBody.trim())
	} else if (message.htmlBody?.trim()) {
		parts.push('', message.htmlBody.trim())
	}
	return parts.join('\n')
}

function buildCompletionSummary(input: {
	assistantText: string
	stopReason: string
	toolCallsUsed: number
	traceUrl: string
}) {
	const intro =
		input.stopReason === 'budget_exhausted'
			? `Kody reached the ${emailAgentToolCallLimit}-tool-call limit while working on your request.`
			: 'Kody completed the email-triggered agent run.'
	const details =
		summarizeText(input.assistantText, 1_200) ??
		'No assistant summary available.'
	return [intro, '', details, '', `Trace: ${input.traceUrl}`].join('\n')
}

async function ensureSystemSenderIdentity(input: {
	env: EmailLoopEnv
	userId: string
	requestUrl: string | URL
}): Promise<ReturnType<typeof buildKodySenderIdentity>> {
	const sender = buildKodySenderIdentity({
		env: input.env,
	})
	await upsertEmailSenderIdentity({
		db: input.env.APP_DB,
		userId: input.userId,
		email: sender.email,
		domain: getEmailDomain(sender.email),
		displayName: sender.displayName,
		status: 'verified',
	})
	return sender
}

export async function runInboundEmailAgentLoop(input: {
	env: EmailLoopEnv
	requestUrl: string | URL
	inbox: EmailInboxRecord
	message: EmailMessageRecord
	previousRun?: Awaited<
		ReturnType<typeof getLatestEmailAgentRunForThread>
	> | null
}): Promise<EmailLoopResult> {
	const sender = await ensureSystemSenderIdentity({
		env: input.env,
		userId: input.inbox.userId,
		requestUrl: input.requestUrl,
	})
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const sessionId = buildEmailAgentSessionId(
		input.message.threadId ?? input.message.id,
	)
	const callerContext = createMcpCallerContext({
		baseUrl,
		user: {
			userId: input.inbox.userId,
			email: input.inbox.ownerEmail?.trim() || sender.email,
			displayName: input.inbox.ownerDisplayName?.trim() || sender.displayName,
		},
		storageContext: input.inbox.packageId
			? {
					sessionId: null,
					appId: input.inbox.packageId,
					storageId: input.inbox.packageId,
				}
			: null,
		capabilityRestrictions: {
			denyNames: [...blockedEmailCapabilityNames],
			denyDomains: null,
		},
	})
	const startedAt = new Date().toISOString()
	const pendingRun = await createEmailAgentRun({
		db: input.env.APP_DB,
		userId: input.inbox.userId,
		inboxId: input.message.inboxId,
		threadId: input.message.threadId,
		inboundMessageId: input.message.id,
		sessionId,
		conversationId:
			input.previousRun?.conversationId ??
			`email-${input.message.threadId ?? input.message.id}`,
		status: 'running',
		toolCallLimit: emailAgentToolCallLimit,
		startedAt,
	})
	const traceUrl = buildTraceUrl({
		baseUrl,
		inboundMessageId: input.message.id,
		runId: pendingRun.id,
	})
	await updateEmailAgentRun({
		db: input.env.APP_DB,
		id: pendingRun.id,
		traceUrl,
	})
	await insertEmailDeliveryEvent({
		db: input.env.APP_DB,
		messageId: input.message.id,
		userId: input.inbox.userId,
		inboxId: input.message.inboxId,
		eventType: 'agent_loop_started',
		provider: 'kody-email-agent',
		detail: {
			runId: pendingRun.id,
			sessionId,
			traceUrl,
		},
	})

	try {
		const started = await beginAgentTurn({
			env: input.env as AgentLoopRuntimeEnv,
			callerContext,
			turn: {
				sessionId,
				conversationId:
					input.previousRun?.conversationId ??
					`email-${input.message.threadId ?? input.message.id}`,
				maxSteps: emailAgentToolCallLimit,
				system: buildAgentSystemPrompt({
					inbox: input.inbox,
					sender:
						input.message.fromAddress ??
						input.message.envelopeFrom ??
						'unknown',
				}),
				messages: [
					{
						role: 'user',
						content: buildAgentUserMessage(input.message),
					},
				],
				memoryContext: {
					task: 'Respond to an inbound approved email',
					query: input.message.subject ?? undefined,
					entities: [
						input.message.fromAddress ??
							input.message.envelopeFrom ??
							'unknown',
					],
				},
			},
		})
		const events = await collectAgentTurnEvents({
			env: input.env as AgentLoopRuntimeEnv,
			sessionId,
			runId: started.runId,
		})
		const turnComplete = events.find(
			(
				event,
			): event is Extract<(typeof events)[number], { type: 'turn_complete' }> =>
				event.type === 'turn_complete',
		)
		if (!turnComplete) {
			throw new Error(
				'Inbound email agent loop completed without turn_complete.',
			)
		}

		const status =
			turnComplete.stopReason === 'budget_exhausted'
				? 'limit_reached'
				: 'completed'
		const toolCallsUsed = turnComplete.toolCalls.length
		const completedAt = new Date().toISOString()
		await updateEmailAgentRun({
			db: input.env.APP_DB,
			id: pendingRun.id,
			status,
			toolCallsUsed,
			traceUrl,
			summary: summarizeText(turnComplete.assistantText, 1_500),
			assistantText: turnComplete.assistantText,
			stopReason: turnComplete.stopReason,
			finishReason: turnComplete.finishReason,
			completedAt,
		})

		const replyToAddress =
			input.message.replyToAddresses.find(
				(value): value is string =>
					typeof value === 'string' && value.length > 0,
			) ??
			input.message.fromAddress ??
			input.message.envelopeFrom
		if (!replyToAddress) {
			throw new Error('Inbound email has no reply-to address.')
		}

		const replyResult = await sendOutboundEmail({
			env: input.env,
			userId: input.inbox.userId,
			from: sender.email,
			allowSystemSender: true,
			to: replyToAddress,
			subject: input.message.subject?.toLowerCase().startsWith('re:')
				? (input.message.subject ?? 'Re: inbound email')
				: `Re: ${input.message.subject ?? '(no subject)'}`,
			text: buildCompletionSummary({
				assistantText: turnComplete.assistantText,
				stopReason: turnComplete.stopReason,
				toolCallsUsed,
				traceUrl,
			}),
			inReplyToHeader: input.message.messageIdHeader ?? null,
			references: [
				...input.message.references.filter(
					(value): value is string => typeof value === 'string',
				),
				...(input.message.messageIdHeader
					? [input.message.messageIdHeader]
					: []),
			],
			threadId: input.message.threadId,
			inboxId: input.message.inboxId,
		})
		await updateEmailAgentRun({
			db: input.env.APP_DB,
			id: pendingRun.id,
			replyMessageId: replyResult.message.id,
		})
		await insertEmailDeliveryEvent({
			db: input.env.APP_DB,
			messageId: input.message.id,
			userId: input.inbox.userId,
			inboxId: input.message.inboxId,
			eventType:
				status === 'limit_reached'
					? 'agent_loop_limit_reached'
					: 'agent_loop_completed',
			provider: 'kody-email-agent',
			detail: {
				runId: pendingRun.id,
				replyMessageId: replyResult.message.id,
				traceUrl,
				toolCallsUsed,
				stopReason: turnComplete.stopReason,
			},
		})
		return {
			run: {
				...pendingRun,
				status,
				toolCallsUsed,
				traceUrl,
				summary: summarizeText(turnComplete.assistantText, 1_500),
				assistantText: turnComplete.assistantText,
				stopReason: turnComplete.stopReason,
				finishReason: turnComplete.finishReason,
				replyMessageId: replyResult.message.id,
				completedAt,
				updatedAt: completedAt,
			},
			replyMessageId: replyResult.message.id,
		}
	} catch (error) {
		const completedAt = new Date().toISOString()
		const errorMessage =
			error instanceof Error
				? error.message
				: 'Inbound email agent loop failed.'
		await updateEmailAgentRun({
			db: input.env.APP_DB,
			id: pendingRun.id,
			status: 'failed',
			traceUrl,
			error: errorMessage,
			completedAt,
		}).catch(() => undefined)
		await insertEmailDeliveryEvent({
			db: input.env.APP_DB,
			messageId: input.message.id,
			userId: input.inbox.userId,
			inboxId: input.message.inboxId,
			eventType: 'agent_loop_failed',
			provider: 'kody-email-agent',
			detail: {
				runId: pendingRun.id,
				traceUrl,
				error: errorMessage,
			},
		}).catch(() => undefined)
		throw error
	}
}
