import { codemode } from 'kody:runtime'

export type UnleashedAjaxAction = 'getstat' | 'setconf' | 'docmd'

export type UnleashedRawRequest = {
	action: UnleashedAjaxAction
	comp: string
	xmlBody: string
	updater?: string
	reason: string
}

export type UnleashedRequestResult = {
	action: UnleashedAjaxAction
	comp: string
	updater: string
	xml: string
	parsed: unknown
}

const requestConfirmation =
	'I am highly certain making this raw Access Networks Unleashed AJAX request is necessary right now.'

function ensureMinimumReason(reason: string) {
	const trimmed = reason.trim()
	if (trimmed.length < 20) {
		throw new Error(
			`@kentcdodds/unleashed-wifi: reason must be at least 20 characters; got ${trimmed.length}.`,
		)
	}
	return trimmed
}

export async function unleashedRequest(
	input: UnleashedRawRequest,
): Promise<UnleashedRequestResult> {
	const reason = ensureMinimumReason(input.reason)
	const result = await codemode.home_access_networks_unleashed_request({
		action: input.action,
		comp: input.comp,
		xmlBody: input.xmlBody,
		updater: input.updater,
		acknowledgeHighRisk: true,
		reason,
		confirmation: requestConfirmation,
	})
	const structured = result.structuredContent
	if (
		!structured ||
		typeof structured.xml !== 'string' ||
		typeof structured.action !== 'string' ||
		typeof structured.comp !== 'string' ||
		typeof structured.updater !== 'string'
	) {
		throw new Error(
			'@kentcdodds/unleashed-wifi: home_access_networks_unleashed_request returned an unexpected response shape.',
		)
	}
	return {
		action: structured.action,
		comp: structured.comp,
		updater: structured.updater,
		xml: structured.xml,
		parsed: structured.parsed,
	}
}

export type UnleashedReason = {
	reason: string
}

const minimumReasonHelp =
	'Provide an at-least 20 character justification for why this Access Networks Unleashed mutation is necessary right now.'

export function describeMinimumReason() {
	return minimumReasonHelp
}
