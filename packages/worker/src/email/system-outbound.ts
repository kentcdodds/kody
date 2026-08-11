import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { normalizeEmailAddress } from './address.ts'
import { getSystemEmailDomain } from './platform-address.ts'
import {
	consumeSystemEmailDailySend,
	isSystemEmailLocal,
	refundSystemEmailDailySend,
	systemEmailLocals,
	type SystemEmailLocal,
} from './system-email.ts'

type SystemOutboundEnv = Pick<
	Env,
	| 'APP_DB'
	| 'APP_BASE_URL'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
> & { SYSTEM_EMAIL_DOMAIN?: string | null }

/**
 * Ceiling on recipients per operator send. System mail is transactional
 * one-to-one correspondence (a reply to a report, a heads-up to one user),
 * never a mailing list: bulk sending belongs on a marketing provider with
 * its own consent and unsubscribe handling.
 */
export const maxSystemOutboundRecipients = 5

export type SystemOutboundResult = {
	from: string
	to: Array<string>
	providerMessageId: string | null
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

/**
 * The provider requires an HTML body. Text-only callers get the same
 * paragraph-per-blank-line rendering the platform's own alert mail uses.
 */
function htmlFromText(text: string) {
	const paragraphs = text
		.split(/\n{2,}/u)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0)
		.map(
			(paragraph) =>
				`<p>${escapeHtml(paragraph).replaceAll('\n', '<br />')}</p>`,
		)
		.join('')
	return `<!doctype html><html lang="en"><body>${paragraphs}</body></html>`
}

function resolveRecipients(to: string | Array<string>): Array<string> {
	const values = Array.isArray(to) ? to : [to]
	const recipients: Array<string> = []
	for (const value of values) {
		const address = normalizeEmailAddress(value)
		if (!address) {
			throw new McpCallerError(`Invalid recipient email address: ${value}`)
		}
		if (!recipients.includes(address)) recipients.push(address)
	}
	if (recipients.length === 0) {
		throw new McpCallerError(
			'At least one recipient email address is required.',
		)
	}
	if (recipients.length > maxSystemOutboundRecipients) {
		throw new McpCallerError(
			`System email allows at most ${maxSystemOutboundRecipients} recipients per message.`,
		)
	}
	return recipients
}

/**
 * Send transactional mail from a reserved system sender
 * (`{local}@<system domain>`) to arbitrary recipients.
 *
 * This is the operator correspondence channel, structurally separate from
 * user mail: it does not touch any user mailbox, sender identity, or plan
 * entitlement, and it is protected by its own per-sender daily cap so a
 * runaway caller cannot burn the apex domain's sending reputation. Callers
 * are responsible for the authorization check — today only admin-gated,
 * audit-logged capabilities and internal platform alerts reach it.
 */
export async function sendSystemEmail(input: {
	env: SystemOutboundEnv
	/** Reserved system local part; defaults to the `kody` sender. */
	localPart?: SystemEmailLocal
	to: string | Array<string>
	subject: string
	text?: string | null
	html?: string | null
	replyTo?: string | null
	now?: Date
}): Promise<SystemOutboundResult> {
	const localPart = input.localPart ?? 'kody'
	if (!isSystemEmailLocal(localPart)) {
		throw new McpCallerError(
			`Unknown system sender "${localPart}". Expected one of: ${systemEmailLocals.join(', ')}.`,
		)
	}
	const domain = getSystemEmailDomain(input.env)
	if (!domain) {
		throw new Error(
			'System email is unavailable because no system email domain is configured.',
		)
	}
	const from = `${localPart}@${domain}`
	const to = resolveRecipients(input.to)
	const subject = input.subject.trim()
	if (!subject) throw new McpCallerError('Email subject is required.')
	const text = input.text?.trim() || null
	const html = input.html?.trim() || null
	if (!text && !html) {
		throw new McpCallerError('Email text or HTML body is required.')
	}
	const replyTo = input.replyTo ? normalizeEmailAddress(input.replyTo) : null
	if (input.replyTo && !replyTo) {
		throw new McpCallerError(`Invalid reply-to address: ${input.replyTo}`)
	}

	const now = input.now ?? new Date()
	const consumed = await consumeSystemEmailDailySend({
		db: input.env.APP_DB,
		localPart,
		now,
	})
	if (consumed === null) {
		throw new McpCallerError(
			`Daily system email send limit reached for ${from}. Try again tomorrow.`,
		)
	}

	let result: Awaited<ReturnType<typeof sendCloudflareEmail>>
	try {
		result = await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			{
				to: to.length === 1 ? to[0]! : to,
				from,
				subject,
				html: html ?? htmlFromText(text ?? ''),
				text: text ?? undefined,
				...(replyTo ? { replyTo } : {}),
			},
		)
	} catch (error) {
		await refundSystemEmailDailySend({
			db: input.env.APP_DB,
			localPart,
			now,
		})
		throw error
	}
	if (!result.ok) {
		await refundSystemEmailDailySend({
			db: input.env.APP_DB,
			localPart,
			now,
		})
		throw new Error(
			result.skipped
				? 'System email was skipped because no Cloudflare Email credentials are configured.'
				: (result.error ?? 'System email send failed.'),
		)
	}
	return { from, to, providerMessageId: result.messageId ?? null }
}
