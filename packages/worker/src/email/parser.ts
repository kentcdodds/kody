import { maxPlanEmailLimits } from '#universal/plans.ts'
import PostalMime, {
	type Address as PostalAddress,
	type Attachment as PostalAttachment,
} from 'postal-mime'
import { normalizeEmailAddress, parseHeaderAddressList } from './address.ts'
import {
	type EmailAttachmentMetadata,
	type EmailMailbox,
	type ParsedInboundEmail,
} from './types.ts'

/**
 * Platform inbound MIME ceiling. Same bound as paid/max
 * `email_message_bytes` so accepted mail is read and stored instead of
 * thrown as a retryable read failure.
 */
export const maxRawMimeBytes = maxPlanEmailLimits.email_message_bytes

export class InboundRawMimeTooLargeError extends Error {
	override name = 'InboundRawMimeTooLargeError'
	readonly rawSize: number
	readonly maxRawSize: number
	constructor(rawSize: number, maxRawSize: number) {
		super(
			`Inbound email raw MIME is too large (${rawSize} bytes, max ${maxRawSize}).`,
		)
		this.rawSize = rawSize
		this.maxRawSize = maxRawSize
	}
}

function flattenPostalAddresses(
	addresses: PostalAddress | Array<PostalAddress> | undefined,
): Array<EmailMailbox> {
	const input = Array.isArray(addresses)
		? addresses
		: addresses
			? [addresses]
			: []
	const out: Array<EmailMailbox> = []
	for (const address of input) {
		if ('group' in address && Array.isArray(address.group)) {
			for (const groupAddress of address.group) {
				const normalized = normalizeEmailAddress(groupAddress.address)
				if (normalized) {
					out.push({ name: groupAddress.name || null, address: normalized })
				}
			}
			continue
		}
		if (!address.address) continue
		const normalized = normalizeEmailAddress(address.address)
		if (normalized)
			out.push({ name: address.name || null, address: normalized })
	}
	return out
}

function normalizeReferences(value: string | undefined) {
	if (!value) return []
	return value
		.split(/\s+/)
		.map((entry) => entry.trim())
		.filter(Boolean)
}

function headersToRecord(
	parsedHeaders: Array<{ name: string; value: string }>,
) {
	const record: Record<string, Array<string>> = {}
	for (const header of parsedHeaders) {
		const key = header.name.toLowerCase()
		record[key] = [...(record[key] ?? []), header.value]
	}
	return record
}

function getHeader(headers: Headers, name: string) {
	return headers.get(name)?.trim() || null
}

function getPostalHeader(
	headers: Array<{ key: string; value: string }>,
	name: string,
) {
	const normalized = name.toLowerCase()
	return (
		headers.find((header) => header.key.toLowerCase() === normalized)?.value ??
		null
	)
}

function attachmentSize(attachment: PostalAttachment) {
	const content = attachment.content
	if (typeof content === 'string') {
		return new TextEncoder().encode(content).byteLength
	}
	return content.byteLength
}

function toAttachmentMetadata(
	attachments: Array<PostalAttachment>,
): Array<EmailAttachmentMetadata> {
	return attachments.map((attachment) => ({
		filename: attachment.filename,
		contentType: attachment.mimeType,
		contentId: attachment.contentId ?? null,
		disposition: attachment.disposition,
		size: attachmentSize(attachment),
	}))
}

function dedupeMailboxes(addresses: Array<EmailMailbox>) {
	const seen = new Set<string>()
	const out: Array<EmailMailbox> = []
	for (const mailbox of addresses) {
		if (seen.has(mailbox.address)) continue
		seen.add(mailbox.address)
		out.push(mailbox)
	}
	return out
}

export async function parseForwardableEmailMessage(
	message: ForwardableEmailMessage,
	options: { maxRawSize?: number } = {},
): Promise<ParsedInboundEmail> {
	const maxRawSize = options.maxRawSize ?? maxRawMimeBytes
	if (message.rawSize > maxRawSize) {
		throw new InboundRawMimeTooLargeError(message.rawSize, maxRawSize)
	}
	const rawMime = await readForwardableEmailRawMime(message)
	return await parseForwardableEmailRawMime(message, rawMime)
}

export async function readForwardableEmailRawMime(
	message: ForwardableEmailMessage,
) {
	if (message.rawSize > maxRawMimeBytes) {
		throw new InboundRawMimeTooLargeError(message.rawSize, maxRawMimeBytes)
	}
	return await new Response(message.raw).text()
}

export async function parseForwardableEmailRawMime(
	message: ForwardableEmailMessage,
	rawMime: string,
): Promise<ParsedInboundEmail> {
	const parsed = await PostalMime.parse(rawMime, {
		attachmentEncoding: 'arraybuffer',
	})
	const parsedHeaders = parsed.headers.map((header) => ({
		name: header.originalKey || header.key,
		value: header.value,
	}))
	const headerFrom = flattenPostalAddresses(parsed.from)
	const headerFromFallback = parseHeaderAddressList(
		getHeader(message.headers, 'From'),
	)[0]
	const fromAddress =
		headerFrom[0]?.address ??
		headerFromFallback?.address ??
		normalizeEmailAddress(message.from) ??
		null
	const normalizedEnvelopeTo = normalizeEmailAddress(message.to)
	const toAddresses = dedupeMailboxes([
		...(normalizedEnvelopeTo
			? [{ name: null, address: normalizedEnvelopeTo }]
			: []),
		...flattenPostalAddresses(parsed.to),
		...parseHeaderAddressList(getHeader(message.headers, 'To')),
	])
	const ccAddresses = dedupeMailboxes(flattenPostalAddresses(parsed.cc))
	const bccAddresses = dedupeMailboxes(flattenPostalAddresses(parsed.bcc))
	const replyToAddresses = dedupeMailboxes(
		flattenPostalAddresses(parsed.replyTo),
	)
	const subject = parsed.subject ?? getHeader(message.headers, 'Subject')
	const messageIdHeader =
		parsed.messageId ?? getPostalHeader(parsed.headers, 'message-id')
	const inReplyToHeader =
		parsed.inReplyTo ?? getPostalHeader(parsed.headers, 'in-reply-to')
	return {
		envelopeFrom: normalizeEmailAddress(message.from) ?? message.from,
		envelopeTo: normalizeEmailAddress(message.to) ?? message.to,
		headerFrom: fromAddress,
		to: toAddresses,
		cc: ccAddresses,
		bcc: bccAddresses,
		replyTo: replyToAddresses,
		subject,
		messageId: messageIdHeader ?? null,
		inReplyTo: inReplyToHeader ?? null,
		references: normalizeReferences(parsed.references),
		headers: headersToRecord(parsedHeaders),
		authResults:
			getHeader(message.headers, 'Authentication-Results') ??
			getHeader(message.headers, 'ARC-Authentication-Results'),
		textBody: parsed.text || null,
		htmlBody:
			typeof parsed.html === 'string' && parsed.html ? parsed.html : null,
		rawMime,
		rawSize: message.rawSize,
		attachments: toAttachmentMetadata(parsed.attachments),
	}
}
