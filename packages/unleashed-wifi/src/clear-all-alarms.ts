import { unleashedRequest } from './internal/request.ts'

const defaultReason =
	'Clearing every active Access Networks Unleashed alarm at the operator request.'

/** Clear every active alarm on the controller. */
export async function clearAllAlarms(input: { reason?: string } = {}) {
	const result = await unleashedRequest({
		action: 'docmd',
		comp: 'stamgr',
		xmlBody: "<xcmd cmd='ack-alarm' tag='alarm' all='true'/>",
		reason: input.reason ?? defaultReason,
	})
	return result
}
