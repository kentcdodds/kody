import { isReservedUsername } from '#app/reserved-usernames.ts'
import { findPublicUserIdentityByUsername } from '#app/user-lookup.ts'
import { normalizeEmailAddress, normalizeSubject } from './address.ts'
import { ensureDefaultEmailInbox } from './default-inbox.ts'
import { parseForwardableEmailMessage } from './parser.ts'
import { getPlatformEmailDomain } from './platform-address.ts'
import {
	createEmailThread,
	findEmailThreadForInboundMessage,
	insertEmailDeliveryEvent,
	insertEmailMessageWithAttachments,
	touchEmailThread,
} from './repo.ts'
import { dispatchInboundEmailSubscriptionEvents } from './package-subscriptions.ts'

export async function handleInboundEmail(
	message: ForwardableEmailMessage,
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>,
	_ctx?: ExecutionContext,
) {
	const recipient = normalizeEmailAddress(message.to)
	if (!recipient) {
		message.setReject('Invalid recipient address.')
		return
	}

	const platformDomain = getPlatformEmailDomain(env)
	if (!platformDomain) {
		message.setReject('Email routing is not configured.')
		return
	}

	const atIndex = recipient.lastIndexOf('@')
	const localPart = recipient.slice(0, atIndex)
	const recipientDomain = recipient.slice(atIndex + 1)
	if (recipientDomain !== platformDomain) {
		message.setReject('Unknown Kody email address.')
		return
	}
	if (isReservedUsername(localPart)) {
		message.setReject('This address is reserved for system mail.')
		return
	}

	const account = await findPublicUserIdentityByUsername({
		db: env.APP_DB,
		username: localPart,
	})
	if (!account) {
		message.setReject('Unknown Kody email address.')
		return
	}

	const userId = account.mcpUserId
	const provisioned = await ensureDefaultEmailInbox({
		db: env.APP_DB,
		userId,
		username: account.username,
		domain: platformDomain,
	})
	if (!provisioned) {
		message.setReject('Email inbox is unavailable.')
		return
	}
	const { inbox } = provisioned
	if (!inbox.enabled) {
		message.setReject('Email inbox is disabled.')
		return
	}

	let parsed: Awaited<ReturnType<typeof parseForwardableEmailMessage>>
	try {
		parsed = await parseForwardableEmailMessage(message)
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : 'Failed to parse inbound email.'
		message.setReject(reason)
		await insertEmailDeliveryEvent({
			db: env.APP_DB,
			userId,
			inboxId: inbox.id,
			eventType: 'rejected',
			provider: 'cloudflare-email-routing',
			detail: {
				recipient,
				reason,
				phase: 'parse',
			},
		}).catch(() => undefined)
		return
	}
	const now = new Date().toISOString()
	const subjectNormalized = normalizeSubject(parsed.subject)
	const existingThread = await findEmailThreadForInboundMessage({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		references: parsed.references,
		inReplyToHeader: parsed.inReplyTo,
	})
	const thread =
		existingThread ??
		(await createEmailThread({
			db: env.APP_DB,
			userId,
			inboxId: inbox.id,
			subjectNormalized,
			rootMessageIdHeader: parsed.messageId,
			lastMessageAt: now,
		}))
	const stored = await insertEmailMessageWithAttachments({
		db: env.APP_DB,
		message: {
			direction: 'inbound',
			userId,
			inboxId: inbox.id,
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
			processingStatus: 'stored',
			providerMessageId: null,
			error: null,
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
		inboxId: inbox.id,
		eventType: 'received',
		provider: 'cloudflare-email-routing',
		detail: {
			recipient,
			envelope_from: parsed.envelopeFrom,
			from_address: parsed.headerFrom,
		},
	})
	const dispatchPromise = dispatchInboundEmailSubscriptionEvents({
		env,
		userId,
		message: stored,
	})
	if (_ctx) {
		_ctx.waitUntil(dispatchPromise)
	} else {
		void dispatchPromise.catch((error) => {
			console.error('Inbound email package subscription dispatch failed', error)
		})
	}
}
