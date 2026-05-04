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

function unwrapResult(raw: unknown) {
	if (raw == null || typeof raw !== 'object') return null
	const candidate = raw as Record<string, unknown>
	const inner =
		candidate['structuredContent'] &&
		typeof candidate['structuredContent'] === 'object'
			? (candidate['structuredContent'] as Record<string, unknown>)
			: candidate
	if (
		typeof inner['action'] !== 'string' ||
		typeof inner['comp'] !== 'string' ||
		typeof inner['updater'] !== 'string' ||
		typeof inner['xml'] !== 'string'
	) {
		return null
	}
	return {
		action: inner['action'] as UnleashedAjaxAction,
		comp: inner['comp'] as string,
		updater: inner['updater'] as string,
		xml: inner['xml'] as string,
		parsed: inner['parsed'] ?? null,
	}
}

export async function unleashedRequest(
	input: UnleashedRawRequest,
): Promise<UnleashedRequestResult> {
	const reason = ensureMinimumReason(input.reason)
	const raw = await codemode.home_access_networks_unleashed_request({
		action: input.action,
		comp: input.comp,
		xmlBody: input.xmlBody,
		updater: input.updater,
		acknowledgeHighRisk: true,
		reason,
		confirmation: requestConfirmation,
	})
	const unwrapped = unwrapResult(raw)
	if (!unwrapped) {
		throw new Error(
			'@kentcdodds/unleashed-wifi: home_access_networks_unleashed_request returned an unexpected response shape.',
		)
	}
	return unwrapped
}

const minimumReasonHelp =
	'Provide an at-least 20 character justification for why this Access Networks Unleashed mutation is necessary right now.'

export function describeMinimumReason() {
	return minimumReasonHelp
}
