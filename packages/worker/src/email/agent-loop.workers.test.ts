import { env } from 'cloudflare:workers'
import { beforeEach, expect, test, vi } from 'vitest'
import { runInboundEmailAgentLoop } from './agent-loop.ts'
import {
	createEmailInbox,
	createEmailThread,
	getEmailMessageById,
	getLatestEmailAgentRunForMessage,
	insertEmailMessage,
	listEmailSenderPolicies,
} from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { getEmailDomain, requireNormalizedEmailAddress } from './address.ts'

const mockAgentTurnApi = vi.hoisted(() => ({
	beginAgentTurn: vi.fn(),
	collectAgentTurnEvents: vi.fn(),
}))

vi.mock('#worker/agent-turn/api.ts', () => ({
	beginAgentTurn: (...args: Array<unknown>) =>
		mockAgentTurnApi.beginAgentTurn(...args),
	collectAgentTurnEvents: (...args: Array<unknown>) =>
		mockAgentTurnApi.collectAgentTurnEvents(...args),
}))

function createEmailEnv() {
	return {
		...env,
		APP_DOMAIN: 'example.com',
		EMAIL: {
			async send() {
				return { messageId: 'provider-message-123' }
			},
		},
	}
}

async function createStoredInboundMessage(input: {
	userId: string
	inboxId: string
	threadId: string
	from: string
	subject: string
	textBody: string
}) {
	return insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'inbound',
			userId: input.userId,
			inboxId: input.inboxId,
			threadId: input.threadId,
			senderIdentityId: null,
			fromAddress: input.from,
			envelopeFrom: input.from,
			toAddresses: ['support@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			replyToAddresses: [],
			subject: input.subject,
			messageIdHeader: `<${crypto.randomUUID()}@example.com>`,
			inReplyToHeader: null,
			references: [],
			headers: {},
			authResults: null,
			textBody: input.textBody,
			htmlBody: null,
			rawMime: null,
			rawSize: 0,
			policyDecision: 'accepted',
			processingStatus: 'stored',
			providerMessageId: null,
			error: null,
			receivedAt: new Date().toISOString(),
			sentAt: null,
		},
	})
}

beforeEach(() => {
	vi.clearAllMocks()
})

test('runInboundEmailAgentLoop replies with summary and stores trace linkage on completion', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-loop-user-${crypto.randomUUID()}`
	const ownerEmail = requireNormalizedEmailAddress(
		`owner-${crypto.randomUUID()}@example.com`,
	)
	const inbox = await createEmailInbox({
		db: env.APP_DB,
		userId,
		ownerEmail,
		ownerDisplayName: 'Owner',
		name: 'Support',
		description: 'Support inbox',
		mode: 'accept',
	})
	const thread = await createEmailThread({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		subjectNormalized: 'approved sender',
	})
	const inbound = await createStoredInboundMessage({
		userId,
		inboxId: inbox.id,
		threadId: thread.id,
		from: 'agent@trusted.example',
		subject: 'Approved sender',
		textBody: 'Please summarize this request.',
	})

	mockAgentTurnApi.beginAgentTurn.mockResolvedValueOnce({
		ok: true,
		runId: 'run-123',
		conversationId: 'conversation-123',
	})
	mockAgentTurnApi.collectAgentTurnEvents.mockResolvedValueOnce([
		{
			type: 'turn_complete',
			assistantText: 'Here is the completed summary.',
			reasoningText: 'thinking',
			summary: null,
			continueRecommended: false,
			needsUserInput: false,
			stepsUsed: 2,
			newInformation: true,
			stopReason: 'completed',
			finishReason: 'stop',
			toolCalls: [
				{ id: 'call-1', toolName: 'search', input: { query: 'summary' } },
				{
					id: 'call-2',
					toolName: 'execute',
					input: { code: 'export default 1' },
				},
			],
			conversationId: 'conversation-123',
		},
	])

	const result = await runInboundEmailAgentLoop({
		env: createEmailEnv(),
		requestUrl: 'https://app.example.com/cdn-cgi/handler/email',
		inbox,
		message: inbound,
	})

	expect(result.replyMessageId).not.toBeNull()
	const run = await getLatestEmailAgentRunForMessage({
		db: env.APP_DB,
		inboundMessageId: inbound.id,
	})
	expect(run).toMatchObject({
		status: 'completed',
		replyMessageId: result.replyMessageId,
		toolCallsUsed: 2,
		conversationId: `email-${thread.id}`,
	})
	expect(run?.traceUrl).toContain('/account/email?selected=')
	const reply = await getEmailMessageById({
		db: env.APP_DB,
		userId,
		messageId: result.replyMessageId!,
	})
	expect(reply).toMatchObject({
		direction: 'outbound',
		processingStatus: 'sent',
		fromAddress: 'kody@example.com',
	})
	expect(reply?.textBody).toContain('Here is the completed summary.')
	expect(reply?.textBody).toContain(run?.traceUrl ?? '')
	const senderPolicies = await listEmailSenderPolicies({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
	})
	expect(senderPolicies).toEqual([])
})

test('runInboundEmailAgentLoop marks budget exhaustion and still replies with trace link', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-loop-limit-user-${crypto.randomUUID()}`
	const ownerEmail = requireNormalizedEmailAddress(
		`owner-${crypto.randomUUID()}@example.com`,
	)
	const inbox = await createEmailInbox({
		db: env.APP_DB,
		userId,
		ownerEmail,
		ownerDisplayName: 'Owner',
		name: 'Support',
		description: 'Support inbox',
		mode: 'accept',
	})
	const thread = await createEmailThread({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		subjectNormalized: 'limit subject',
	})
	const inbound = await createStoredInboundMessage({
		userId,
		inboxId: inbox.id,
		threadId: thread.id,
		from: 'agent@trusted.example',
		subject: 'Limit subject',
		textBody: 'Keep working until the budget is exhausted.',
	})

	mockAgentTurnApi.beginAgentTurn.mockResolvedValueOnce({
		ok: true,
		runId: 'run-limit',
		conversationId: 'conversation-limit',
	})
	mockAgentTurnApi.collectAgentTurnEvents.mockResolvedValueOnce([
		{
			type: 'turn_complete',
			assistantText: 'I used every available tool call.',
			reasoningText: '',
			summary: null,
			continueRecommended: false,
			needsUserInput: false,
			stepsUsed: 20,
			newInformation: true,
			stopReason: 'budget_exhausted',
			finishReason: 'tool-calls',
			toolCalls: Array.from({ length: 20 }, (_value, index) => ({
				id: `call-${index + 1}`,
				toolName: 'search',
				input: { query: `query-${index + 1}` },
			})),
			conversationId: 'conversation-limit',
		},
	])

	const result = await runInboundEmailAgentLoop({
		env: createEmailEnv(),
		requestUrl: 'https://app.example.com/cdn-cgi/handler/email',
		inbox,
		message: inbound,
	})

	const run = await getLatestEmailAgentRunForMessage({
		db: env.APP_DB,
		inboundMessageId: inbound.id,
	})
	expect(run).toMatchObject({
		status: 'limit_reached',
		replyMessageId: result.replyMessageId,
		toolCallsUsed: 20,
		stopReason: 'budget_exhausted',
	})
	const reply = await getEmailMessageById({
		db: env.APP_DB,
		userId,
		messageId: result.replyMessageId!,
	})
	expect(reply?.textBody).toContain('20-tool-call limit')
	expect(reply?.textBody).toContain(run?.traceUrl ?? '')
})
