/** Platform transactional From local (`kody@<apex>`). */
const transactionalSenderLocal = 'kody'

/** Default Reply-To local when From is the transactional sender. */
const transactionalSenderDefaultReplyToLocal = 'support'

/**
 * Resolve Reply-To for outbound mail. An explicit `replyTo` always wins.
 * Otherwise mail From `kody@<domain>` replies to `support@<domain>` so human
 * replies land on support rather than the transactional sender.
 */
export function resolveTransactionalSenderReplyTo(input: {
	from: string
	replyTo?: string | null
}): string | undefined {
	const explicit = input.replyTo?.trim()
	if (explicit) return explicit

	const from = input.from.trim()
	const at = from.lastIndexOf('@')
	if (at <= 0 || at === from.length - 1) return undefined
	const local = from.slice(0, at).toLowerCase()
	const domain = from.slice(at + 1).toLowerCase()
	if (local !== transactionalSenderLocal || domain.length === 0) {
		return undefined
	}
	return `${transactionalSenderDefaultReplyToLocal}@${domain}`
}
