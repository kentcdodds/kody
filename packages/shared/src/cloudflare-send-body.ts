/**
 * Cloudflare Email Sending REST (`POST .../email/sending/send`) uses snake_case
 * `reply_to`. The Workers binding uses camelCase `replyTo`. Internal outbound
 * mail stays `replyTo`; only this mapper changes the REST wire field.
 * @see https://developers.cloudflare.com/email-service/examples/email-sending/recipients/
 */
export function toCloudflareSendBody<T extends { replyTo?: string | null }>(
	outbound: T,
): Omit<T, 'replyTo'> & { reply_to?: string } {
	const { replyTo, ...rest } = outbound
	const trimmed = replyTo?.trim()
	if (!trimmed) {
		return rest
	}
	return { ...rest, reply_to: trimmed }
}
