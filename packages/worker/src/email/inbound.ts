import {
	findReplyTokenHash,
	normalizeEmailAddress,
	normalizeSubject,
} from './address.ts'
import { parseForwardableEmailMessage } from './parser.ts'
import { evaluateSenderPolicy } from './policy.ts'
import {
	createEmailThread,
	findEmailThreadForInboundMessage,
	getEmailInboxById,
	getEmailInboxAddressByAddress,
	getEmailInboxAddressByReplyTokenHash,
	insertEmailDeliveryEvent,
	insertEmailMessageWithAttachments,
	listEmailSenderPolicies,
	touchEmailThread,
} from './repo.ts'

const unknownInboxUserId = 'unknown'

export async function handleInboundEmail(
	message: ForwardableEmailMessage,
	env: Pick<Env, 'APP_DB'>,
	_ctx?: ExecutionContext,
) {
	const recipient = normalizeEmailAddress(message.to)
	if (!recipient) {
		message.setReject('Invalid recipient address.')
		return
	}

	const explicitReplyTokenHash = await findReplyTokenHash({
		headers: message.headers,
		recipients: [recipient],
	})
	const inboxAddress =
		(await getEmailInboxAddressByAddress({
			db: env.APP_DB,
			address: recipient,
		})) ??
		(explicitReplyTokenHash
			? await getEmailInboxAddressByReplyTokenHash({
					db: env.APP_DB,
					replyTokenHash: explicitReplyTokenHash,
				})
			: null)
	const inbox = inboxAddress
		? await getEmailInboxById({
				db: env.APP_DB,
				id: inboxAddress.inboxId,
			})
		: null

	if (inboxAddress && !inbox) {
		message.setReject('Email inbox is unavailable.')
		return
	}
	if (inbox && !inbox.enabled) {
		message.setReject('Email inbox is disabled.')
		return
	}

	const userId = inboxAddress?.userId ?? inbox?.userId ?? unknownInboxUserId
	const parsed = await parseForwardableEmailMessage(message)
	const policies = inboxAddress
		? await listEmailSenderPolicies({
				db: env.APP_DB,
				userId,
				inboxId: inboxAddress.inboxId,
			})
		: []
	const decision = await evaluateSenderPolicy({
		envelopeFrom: parsed.envelopeFrom,
		fromAddress: parsed.headerFrom,
		replyToken: parsed.replyToken,
		rules: policies,
	})
	const policyDecision = inboxAddress ? decision.decision : 'quarantined'
	const now = new Date().toISOString()
	const subjectNormalized = normalizeSubject(parsed.subject)
	const existingThread =
		inboxAddress && inbox
			? await findEmailThreadForInboundMessage({
					db: env.APP_DB,
					userId,
					inboxId: inbox.id,
					references: parsed.references,
					inReplyToHeader: parsed.inReplyTo,
					subjectNormalized,
				})
			: null
	const thread =
		existingThread ??
		(await createEmailThread({
			db: env.APP_DB,
			userId,
			inboxId: inbox?.id ?? null,
			subjectNormalized,
			rootMessageIdHeader: parsed.messageId,
			lastMessageAt: now,
		}))
	const stored = await insertEmailMessageWithAttachments({
		db: env.APP_DB,
		message: {
			direction: 'inbound',
			userId,
			inboxId: inbox?.id ?? null,
			threadId: thread.id,
			senderIdentityId: null,
			fromAddress: parsed.headerFrom,
			envelopeFrom: parsed.envelopeFrom,
			toAddresses: parsed.to.map((entry) => entry.address),
			ccAddresses: parsed.cc.map((entry) => entry.address),
			bccAddresses: parsed.bcc.map((entry) => entry.address),
			replyToAddresses: parsed.replyTo.map((entry) => entry.address),
			subject: parsed.subject,
			messageIdHeader: parsed.messageId,
			inReplyToHeader: parsed.inReplyTo,
			references: parsed.references,
			headers: parsed.headers,
			authResults: parsed.authResults,
			textBody: parsed.textBody,
			htmlBody: parsed.htmlBody,
			rawMime: parsed.rawMime,
			rawSize: parsed.rawSize,
			policyDecision,
			processingStatus: 'stored',
			providerMessageId: null,
			error:
				!inboxAddress
					? `unknown inbox alias: ${recipient}`
					: policyDecision === 'rejected'
						? decision.reasons.join(', ')
						: null,
			receivedAt: now,
			sentAt: null,
		},
		attachments: parsed.attachments.map((attachment) => ({
			filename: attachment.filename,
			contentType: attachment.contentType,
			contentId: attachment.contentId,
			disposition: attachment.disposition,
			size: attachment.size,
			storageKind: 'raw-mime',
			storageKey: null,
		})),
	})
	await touchEmailThread({
		db: env.APP_DB,
		threadId: thread.id,
		lastMessageAt: now,
	})
	await insertEmailDeliveryEvent({
		db: env.APP_DB,
		messageId: stored.id,
		userId,
		inboxId: inbox?.id ?? null,
		eventType:
			policyDecision === 'accepted'
				? 'received'
				: policyDecision === 'quarantined'
					? 'quarantined'
					: 'rejected',
		provider: 'cloudflare-email-routing',
		detail: {
			recipient,
			decision: policyDecision,
			reasons: inboxAddress
				? decision.reasons
				: [`unknown inbox alias: ${recipient}`],
		},
	})
	if (policyDecision === 'rejected') {
		message.setReject(decision.reasons.join(', '))
	}
}
